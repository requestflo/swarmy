import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { fireEvent, systemContext } from '@swarmy/trpc';
import { STACK_LABEL } from '@swarmy/core';
import type { ContainerInfo, ServiceSpec, SwarmServiceInfo } from '@swarmy/core/protocol';
import { hub, store } from '../gateway';

/**
 * Managed-cache reconcile worker (slice A3).
 *
 * Every ~30s, for each org, read the managed cache clusters off the LIVE
 * inventory (services carrying `swarmy.cache.engine` + `swarmy.cache.cluster`)
 * and CONVERGE each cluster's member set to its declared topology
 * (`swarmy.cache.topology`): base replica count, the 3-member sentinel trio,
 * region-pinned replica siblings, and maxmemory drift (via the
 * `swarmy.cache.appliedMemoryMb` stamp). Each tick it also samples `INFO` on
 * the primary (exec — the password stays inside the container's secret file)
 * and stamps the result as the `swarmy.cache.stats` label, firing alert events
 * when used memory crosses 90% of maxmemory or the primary is down.
 *
 * Pure Docker-truth: reads the hub snapshot, dispatches to the org's manager,
 * no DB rows. The label scheme, spec builders and diff planner mirror
 * `@swarmy/trpc` cache.service.ts (the unit-tested canonical copies) — a worker
 * cannot subpath-import an internal trpc module, same constraint the
 * manageddb/geodns reconcile workers document.
 */

const TICK_MS = 30_000;

// ── Label scheme — kept in sync with @swarmy/trpc cache.service.ts ────────────
const CACHE_ENGINE_LABEL = 'swarmy.cache.engine';
const CACHE_CLUSTER_LABEL = 'swarmy.cache.cluster';
const CACHE_ROLE_LABEL = 'swarmy.cache.role';
const CACHE_TOPOLOGY_LABEL = 'swarmy.cache.topology';
const CACHE_MEMORY_LABEL = 'swarmy.cache.memoryMb';
const CACHE_APPLIED_MEMORY_LABEL = 'swarmy.cache.appliedMemoryMb';
const CACHE_REPLICAS_LABEL = 'swarmy.cache.replicas';
const CACHE_REGION_LABEL = 'swarmy.cache.region';
const CACHE_STATS_LABEL = 'swarmy.cache.stats';
const MANAGED_LABEL = 'swarmy.managed';
const SCALE_TO_ZERO_EXEMPT_LABEL = 'swarmy.scaleToZero.exempt';
const REGION_NODE_LABEL = 'swarmy.region';
const CACHE_REGION_REPLICAS_RE = /^swarmy\.cache\.region\.(.+)\.replicas$/;
const SWARM_SERVICE_ID_LABEL = 'com.docker.swarm.service.id';

const CACHE_PORT = 6379;
const CACHE_IMAGES: Record<CacheEngine, string> = {
  valkey: 'valkey/valkey:8',
  redis: 'bitnami/redis:7.4',
};
const SENTINEL_IMAGE = 'bitnami/redis-sentinel:7.4';
const SENTINEL_COUNT = 3;
const SENTINEL_QUORUM = 2;
const SECRET_TARGET = 'cache-password';
const MB = 1024 * 1024;
const MEMORY_ALERT_PCT = 90;

type CacheEngine = 'valkey' | 'redis';
type CacheTopology = 'single' | 'replica' | 'sentinel';
const TOPOLOGIES: readonly string[] = ['single', 'replica', 'sentinel'];

// ── Cluster indexing ──────────────────────────────────────────────────────────

interface Cluster {
  stack: string;
  cluster: string;
  /** `<stack>_<cluster>` — member names derive from this. */
  base: string;
  primary?: SwarmServiceInfo;
  replica?: SwarmServiceInfo;
  sentinel?: SwarmServiceInfo;
  /** region → region-pinned replica sibling. */
  regionSiblings: Map<string, SwarmServiceInfo>;
}

interface Decl {
  engine: CacheEngine;
  topology: CacheTopology;
  memoryMb: number;
  replicas: number;
  regionReplicas: Record<string, number>;
}

function topologyOf(labels: Record<string, string> | undefined): CacheTopology {
  const v = labels?.[CACHE_TOPOLOGY_LABEL];
  return v && TOPOLOGIES.includes(v) ? (v as CacheTopology) : 'single';
}

function declOf(c: Cluster): Decl {
  const anchor = c.primary?.labels ?? c.replica?.labels ?? c.sentinel?.labels ?? {};
  const memory = Number.parseInt(anchor[CACHE_MEMORY_LABEL] ?? '', 10);
  const replicas = Number.parseInt(anchor[CACHE_REPLICAS_LABEL] ?? '', 10);
  const regionReplicas: Record<string, number> = {};
  for (const [key, value] of Object.entries(anchor)) {
    const m = CACHE_REGION_REPLICAS_RE.exec(key);
    if (!m || !m[1]) continue;
    const n = Number.parseInt(value, 10);
    if (Number.isNaN(n) || n < 0) continue;
    regionReplicas[m[1]] = n;
  }
  return {
    engine: anchor[CACHE_ENGINE_LABEL] === 'redis' ? 'redis' : 'valkey',
    topology: topologyOf(anchor),
    memoryMb: Number.isFinite(memory) && memory > 0 ? memory : 256,
    replicas: Number.isFinite(replicas) && replicas >= 0 ? replicas : 0,
    regionReplicas,
  };
}

// ── Spec builders — mirror of cache.service.ts (unit-tested canonical copy) ───

function labelsFor(
  c: Cluster,
  decl: Decl,
  role: 'primary' | 'replica' | 'sentinel',
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    [MANAGED_LABEL]: 'true',
    [STACK_LABEL]: c.stack,
    [CACHE_ENGINE_LABEL]: decl.engine,
    [CACHE_CLUSTER_LABEL]: c.cluster,
    [CACHE_ROLE_LABEL]: role,
    [CACHE_TOPOLOGY_LABEL]: decl.topology,
    [CACHE_MEMORY_LABEL]: String(decl.memoryMb),
    [CACHE_REPLICAS_LABEL]: String(decl.replicas),
    [SCALE_TO_ZERO_EXEMPT_LABEL]: 'true',
    ...(role === 'sentinel' ? {} : { [CACHE_APPLIED_MEMORY_LABEL]: String(decl.memoryMb) }),
    ...extra,
  };
}

const netName = (c: Cluster) => `${c.base}-cache-net`;
const primaryName = (c: Cluster) => `${c.base}-cache`;
const secretName = (c: Cluster) => `swarmy-cache-${c.base}-password`;

function valkeyCommand(decl: Decl, replicaOf?: string): string {
  const parts = [
    'exec valkey-server',
    `--requirepass "$(cat /run/secrets/${SECRET_TARGET})"`,
    `--masterauth "$(cat /run/secrets/${SECRET_TARGET})"`,
    `--maxmemory ${decl.memoryMb}mb`,
    '--maxmemory-policy allkeys-lru',
    '--appendonly yes',
    '--dir /data',
  ];
  if (replicaOf) parts.push(`--replicaof ${replicaOf} ${CACHE_PORT}`);
  return parts.join(' ');
}

function redisEnv(decl: Decl, mode: 'master' | 'slave', primaryHost: string): Record<string, string> {
  return {
    REDIS_REPLICATION_MODE: mode,
    REDIS_PASSWORD_FILE: `/run/secrets/${SECRET_TARGET}`,
    REDIS_MASTER_PASSWORD_FILE: `/run/secrets/${SECRET_TARGET}`,
    REDIS_AOF_ENABLED: 'yes',
    REDIS_EXTRA_FLAGS: `--maxmemory ${decl.memoryMb}mb --maxmemory-policy allkeys-lru`,
    ...(mode === 'slave'
      ? { REDIS_MASTER_HOST: primaryHost, REDIS_MASTER_PORT_NUMBER: String(CACHE_PORT) }
      : {}),
  };
}

/** A data member spec (primary/replica/region sibling). NO ports — private-only. */
function dataSpec(
  c: Cluster,
  decl: Decl,
  role: 'primary' | 'replica',
  opts: {
    name: string;
    replicas: number;
    extraLabels?: Record<string, string>;
    placement?: ServiceSpec['placement'];
  },
): ServiceSpec {
  const isPrimary = role === 'primary';
  const base: ServiceSpec = {
    name: opts.name,
    image: CACHE_IMAGES[decl.engine],
    mode: { replicated: { replicas: opts.replicas } },
    labels: labelsFor(c, decl, role, opts.extraLabels),
    networks: [netName(c)],
    secrets: [{ source: secretName(c), target: SECRET_TARGET }],
    resources: { limits: { memoryBytes: (decl.memoryMb + 64) * MB } },
    ...(isPrimary
      ? {
          mounts: [
            {
              type: 'volume' as const,
              source: `${c.base}-cache-data`,
              target: decl.engine === 'redis' ? '/bitnami/redis/data' : '/data',
            },
          ],
        }
      : {}),
    ...(opts.placement ? { placement: opts.placement } : {}),
  };
  if (decl.engine === 'valkey') {
    return {
      ...base,
      command: ['sh', '-c'],
      args: [valkeyCommand(decl, isPrimary ? undefined : primaryName(c))],
    };
  }
  return { ...base, env: redisEnv(decl, isPrimary ? 'master' : 'slave', primaryName(c)) };
}

function primarySpec(c: Cluster, decl: Decl): ServiceSpec {
  const regionLabels: Record<string, string> = {};
  for (const [region, n] of Object.entries(decl.regionReplicas)) {
    if (n > 0) regionLabels[`swarmy.cache.region.${region}.replicas`] = String(n);
  }
  return dataSpec(c, decl, 'primary', {
    name: primaryName(c),
    replicas: 1,
    extraLabels: regionLabels,
  });
}

function replicaSpec(c: Cluster, decl: Decl, replicas: number): ServiceSpec {
  return dataSpec(c, decl, 'replica', {
    name: `${c.base}-cache-replica`,
    replicas,
    placement: { preferences: ['spread=node.id'] },
  });
}

function regionReplicaSpec(c: Cluster, decl: Decl, region: string, replicas: number): ServiceSpec {
  return dataSpec(c, decl, 'replica', {
    name: `${c.base}-cache-replica-${region}`,
    replicas,
    extraLabels: { [CACHE_REGION_LABEL]: region },
    placement: { constraints: [`node.labels.${REGION_NODE_LABEL}==${region}`] },
  });
}

function sentinelSpec(c: Cluster, decl: Decl): ServiceSpec {
  return {
    name: `${c.base}-cache-sentinel`,
    image: SENTINEL_IMAGE,
    mode: { replicated: { replicas: SENTINEL_COUNT } },
    env: {
      REDIS_MASTER_HOST: primaryName(c),
      REDIS_MASTER_PORT_NUMBER: String(CACHE_PORT),
      REDIS_MASTER_SET: c.cluster,
      REDIS_SENTINEL_QUORUM: String(SENTINEL_QUORUM),
      REDIS_MASTER_PASSWORD_FILE: `/run/secrets/${SECRET_TARGET}`,
    },
    labels: labelsFor(c, decl, 'sentinel'),
    networks: [netName(c)],
    secrets: [{ source: secretName(c), target: SECRET_TARGET }],
    placement: { preferences: ['spread=node.id'] },
  };
}

// ── Stats sampling (INFO via exec; the password never rides the wire) ─────────

interface StatsSample {
  usedMemoryBytes: number;
  maxMemoryBytes: number;
  connectedClients: number;
  opsPerSec: number;
  keys: number;
  hitRatePct: number | null;
  at: string;
}

/** Mirror of cache.service.ts `parseCacheInfo` (the unit-tested canonical copy). */
function parseInfo(raw: string): Omit<StatsSample, 'at'> | null {
  const fields = new Map<string, string>();
  let keys = 0;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf(':');
    if (i <= 0) continue;
    const key = t.slice(0, i);
    const value = t.slice(i + 1);
    fields.set(key, value);
    if (/^db\d+$/.test(key)) {
      const m = /(?:^|,)keys=(\d+)/.exec(value);
      if (m) keys += Number(m[1]);
    }
  }
  const num = (k: string): number => {
    const n = Number(fields.get(k));
    return Number.isFinite(n) ? n : 0;
  };
  if (!fields.has('used_memory')) return null;
  const hits = num('keyspace_hits');
  const misses = num('keyspace_misses');
  return {
    usedMemoryBytes: num('used_memory'),
    maxMemoryBytes: num('maxmemory'),
    connectedClients: num('connected_clients'),
    opsPerSec: num('instantaneous_ops_per_sec'),
    keys,
    hitRatePct: hits + misses > 0 ? Math.round((hits / (hits + misses)) * 1000) / 10 : null,
  };
}

/** Find a running container for the service + the node hosting it. */
function execTarget(
  orgId: string,
  service: SwarmServiceInfo,
): { nodeId: string; containerId: string } | undefined {
  const orgContainerIds = new Set(hub.liveInventory(orgId).containers.map((cc) => cc.id));
  for (const nodeId of hub.onlineNodeIds()) {
    const match = hub.latestContainers(nodeId).find((cc: ContainerInfo) => {
      if (!orgContainerIds.has(cc.id)) return false;
      const sid = cc.serviceId ?? cc.labels?.[SWARM_SERVICE_ID_LABEL];
      return sid === service.id && cc.state === 'running';
    });
    if (match) return { nodeId, containerId: match.id };
  }
  return undefined;
}

async function sampleStats(orgId: string, c: Cluster, decl: Decl): Promise<StatsSample | null> {
  if (!c.primary || (c.primary.runningReplicas ?? 0) < 1) return null;
  const target = execTarget(orgId, c.primary);
  if (!target) return null;
  const cli = decl.engine === 'redis' ? 'redis-cli' : 'valkey-cli';
  try {
    const res = await hub.dispatch<{ exitCode: number; output?: string }>(
      target.nodeId,
      'exec',
      {
        target: { containerId: target.containerId },
        cmd: ['sh', '-c', `${cli} --no-auth-warning -a "$(cat /run/secrets/${SECRET_TARGET})" INFO`],
        tty: false,
        stream: false,
      },
      { timeoutMs: 20_000 },
    );
    if (res.exitCode !== 0 || !res.output) return null;
    const sample = parseInfo(res.output);
    return sample ? { ...sample, at: new Date().toISOString() } : null;
  } catch {
    return null;
  }
}

// ── Reconcile ─────────────────────────────────────────────────────────────────

async function reconcileOrg(orgId: string): Promise<void> {
  const node = hub.managerNode(orgId);
  if (!node) return;

  const { services } = hub.liveInventory(orgId);
  const clusters = new Map<string, Cluster>();
  for (const s of services) {
    const cluster = s.labels[CACHE_CLUSTER_LABEL];
    if (!cluster || !s.labels[CACHE_ENGINE_LABEL]) continue;
    const stack = s.labels[STACK_LABEL] ?? '';
    const key = `${stack} ${cluster}`;
    const c =
      clusters.get(key) ??
      ({ stack, cluster, base: `${stack}_${cluster}`, regionSiblings: new Map() } as Cluster);
    const role = s.labels[CACHE_ROLE_LABEL];
    const region = s.labels[CACHE_REGION_LABEL];
    if (role === 'primary') c.primary = s;
    else if (role === 'sentinel') c.sentinel = s;
    else if (role === 'replica') {
      if (region) c.regionSiblings.set(region, s);
      else c.replica = s;
    }
    clusters.set(key, c);
  }
  if (clusters.size === 0) return;

  // Dispatch helpers (best-effort; a failed tick simply retries next interval).
  const deploy = (spec: ServiceSpec) =>
    hub.dispatch(node, 'service.deploy', { spec, pullPolicy: 'always' }).catch(() => undefined);
  const scale = (service: string, replicas: number) =>
    hub.dispatch(node, 'service.scale', { service, replicas }).catch(() => undefined);
  const remove = (service: string) =>
    hub.dispatch(node, 'service.remove', { service }).catch(() => undefined);
  const setLabels = (service: string, add: Record<string, string>) =>
    hub.dispatch(node, 'service.updateLabels', { service, add, removeKeys: [] }).catch(() => undefined);
  const ensureNet = (c: Cluster) =>
    hub
      .dispatch(node, 'network.ensure', {
        name: netName(c),
        driver: 'overlay',
        attachable: true,
        labels: { [MANAGED_LABEL]: 'true', [CACHE_CLUSTER_LABEL]: c.cluster },
      })
      .catch(() => undefined);

  const ctx = systemContext({ db: prisma, hub, auth: authRegistry.getAuth() }, orgId);

  for (const c of clusters.values()) {
    const decl = declOf(c);
    const replicaTarget =
      decl.topology === 'single'
        ? 0
        : decl.topology === 'sentinel'
          ? Math.max(1, decl.replicas)
          : decl.replicas;

    // (1) Base read-replica service: create / scale / park at 0.
    if (!c.replica) {
      if (replicaTarget > 0) {
        await ensureNet(c);
        await deploy(replicaSpec(c, decl, replicaTarget));
      }
    } else if ((c.replica.desiredReplicas ?? 0) !== replicaTarget) {
      await scale(c.replica.name, replicaTarget);
    }

    // (2) Sentinel trio exists exactly under the sentinel topology.
    if (decl.topology === 'sentinel') {
      if (!c.sentinel) {
        await ensureNet(c);
        await deploy(sentinelSpec(c, decl));
      } else if ((c.sentinel.desiredReplicas ?? 0) !== SENTINEL_COUNT) {
        await scale(c.sentinel.name, SENTINEL_COUNT);
      }
    } else if (c.sentinel) {
      await remove(c.sentinel.name);
    }

    // (3) Region-pinned replica siblings, declared on the primary's labels.
    for (const [region, n] of Object.entries(decl.regionReplicas)) {
      const sib = c.regionSiblings.get(region);
      if (n <= 0) {
        if (sib) await remove(sib.name);
        continue;
      }
      if (!sib) {
        await ensureNet(c);
        await deploy(regionReplicaSpec(c, decl, region, n));
      } else if ((sib.desiredReplicas ?? 0) !== n) {
        await scale(sib.name, n);
      }
    }
    for (const [region, sib] of c.regionSiblings) {
      if (!(region in decl.regionReplicas) || (decl.regionReplicas[region] ?? 0) <= 0) {
        await remove(sib.name);
      }
    }

    // (4) Memory drift: redeploy any data member built with a different maxmemory.
    const applied = (s: SwarmServiceInfo): number | null => {
      const n = Number.parseInt(s.labels[CACHE_APPLIED_MEMORY_LABEL] ?? '', 10);
      return Number.isFinite(n) ? n : null;
    };
    if (c.primary && applied(c.primary) !== null && applied(c.primary) !== decl.memoryMb) {
      await deploy(primarySpec(c, decl));
    }
    if (c.replica && applied(c.replica) !== null && applied(c.replica) !== decl.memoryMb) {
      await deploy(replicaSpec(c, decl, c.replica.desiredReplicas ?? replicaTarget));
    }
    for (const [region, sib] of c.regionSiblings) {
      if (applied(sib) !== null && applied(sib) !== decl.memoryMb) {
        await deploy(regionReplicaSpec(c, decl, region, sib.desiredReplicas ?? 1));
      }
    }

    // (5) Stats stamp + alerts.
    const primaryDown = Boolean(c.primary && (c.primary.runningReplicas ?? 0) < 1);
    if (primaryDown) {
      await fireEvent(ctx, {
        signal: 'cache-primary-down',
        severity: 'critical',
        resource: c.base,
        message: `Cache ${c.stack}/${c.cluster}: primary is down (0/${c.primary?.desiredReplicas ?? 1} running)`,
      }).catch(() => undefined);
    }
    const stats = await sampleStats(orgId, c, decl);
    if (stats && c.primary) {
      await setLabels(c.primary.name, {
        [CACHE_STATS_LABEL]: JSON.stringify(stats),
      });
      const max = stats.maxMemoryBytes > 0 ? stats.maxMemoryBytes : decl.memoryMb * MB;
      const pct = max > 0 ? (stats.usedMemoryBytes / max) * 100 : 0;
      if (pct > MEMORY_ALERT_PCT) {
        await fireEvent(ctx, {
          signal: 'cache-memory-pressure',
          severity: 'warning',
          resource: c.base,
          message: `Cache ${c.stack}/${c.cluster}: memory at ${Math.round(pct)}% of maxmemory (${decl.memoryMb}MB)`,
        }).catch(() => undefined);
      }
    }
  }
}

export function startCacheReconcile(): () => void {
  const timer = setInterval(() => {
    const orgIds = new Set(store.nodeOrg.values());
    for (const orgId of orgIds) void reconcileOrg(orgId).catch(() => undefined);
  }, TICK_MS);
  return () => clearInterval(timer);
}
