import { randomBytes } from 'node:crypto';
import {
  buildInventory,
  STACK_LABEL,
  type CacheAttachmentView,
  type CacheBackupView,
  type CacheClusterView,
  type CacheEngine,
  type CacheMemberView,
  type CacheProvisionResult,
  type CacheRole,
  type CacheStatsView,
  type CacheTopology,
  type InvService,
  CACHE_TOPOLOGIES,
} from '@swarmy/core';
import { decryptSecret } from '@swarmy/core/crypto';
import type { AttachCacheInput, ProvisionCacheInput } from '@swarmy/core';
import type {
  BackupVolumeResult,
  ListSnapshotsResult,
  ResticRepo,
  RestoreVolumeResult,
  ServiceSpec,
} from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected, mapDispatchError, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { auditRetentionOutcome, stackRetentionFor } from './backups.service';
import { resolveManagerNode } from './dispatch.service';
import { resolveExecTarget } from './live-resolve';

/**
 * Managed cache (slice A3) — Valkey/Redis clusters mirroring manageddb.service.
 *
 * Everything is **Docker-truth**: the topology lives in `swarmy.cache.*` service
 * labels, the password lives in a Docker secret (never in the DB, never returned
 * after provision), and there is NO Prisma model. Members are private-only —
 * no published ports, ever; apps reach the cluster over the per-cluster
 * attachable overlay network by swarm DNS.
 *
 *   single   → one server, no replicas.
 *   replica  → primary + N read replicas (async replication).
 *   sentinel → primary + replicas + 3 bitnami/redis-sentinel members (quorum 2)
 *              arbitrating automatic failover.
 *
 * The cache-reconcile worker converges the live member set to the declared
 * topology each tick, stamps a `swarmy.cache.stats` label (INFO sample), and
 * fires alerts on memory pressure / primary-down. Its label constants + spec
 * builders mirror this file (a worker cannot subpath-import an internal
 * @swarmy/trpc module — the same constraint manageddb-reconcile documents).
 */

// ── Label scheme (Docker-truth; kept in sync with cache-reconcile.ts) ─────────
export const CACHE_ENGINE_LABEL = 'swarmy.cache.engine';
export const CACHE_CLUSTER_LABEL = 'swarmy.cache.cluster';
export const CACHE_ROLE_LABEL = 'swarmy.cache.role';
export const CACHE_TOPOLOGY_LABEL = 'swarmy.cache.topology';
/** Declared maxmemory (MB) — the reconcile target. */
export const CACHE_MEMORY_LABEL = 'swarmy.cache.memoryMb';
/** Memory the member was last DEPLOYED with — reconcile redeploys on drift. */
export const CACHE_APPLIED_MEMORY_LABEL = 'swarmy.cache.appliedMemoryMb';
/** Declared replica count for the cluster (reconcile converges to this). */
export const CACHE_REPLICAS_LABEL = 'swarmy.cache.replicas';
/** Region a region-pinned replica sibling is pinned to (mirrors swarmy.db.region). */
export const CACHE_REGION_LABEL = 'swarmy.cache.region';
/** JSON CacheStatsView stamped on the primary by the reconcile worker. */
export const CACHE_STATS_LABEL = 'swarmy.cache.stats';
/** On an APP service: which cluster it is wired to + the env var name used. */
export const CACHE_INJECT_LABEL = 'swarmy.cache.inject';
export const CACHE_INJECT_VAR_LABEL = 'swarmy.cache.inject.var';
const MANAGED_LABEL = 'swarmy.managed';
const SCALE_TO_ZERO_EXEMPT_LABEL = 'swarmy.scaleToZero.exempt';
/** Node label naming a node's region (shared with region/geodns placement). */
const REGION_NODE_LABEL = 'swarmy.region';
const CACHE_REGION_REPLICAS_RE = /^swarmy\.cache\.region\.(.+)\.replicas$/;

/** Docker label key carrying the per-region replica count for `region`. */
export function cacheRegionReplicasLabelKey(region: string): string {
  return `swarmy.cache.region.${region}.replicas`;
}

// ── Engine constants ──────────────────────────────────────────────────────────
export const CACHE_PORT = 6379;
export const SENTINEL_PORT = 26379;
export const CACHE_IMAGES: Record<CacheEngine, string> = {
  valkey: 'valkey/valkey:8',
  redis: 'bitnami/redis:7.4',
};
export const SENTINEL_IMAGE = 'bitnami/redis-sentinel:7.4';
export const SENTINEL_COUNT = 3;
export const SENTINEL_QUORUM = 2;
export const DEFAULT_CACHE_TOPOLOGY: CacheTopology = 'single';
/** Secret file target inside cluster members (`/run/secrets/cache-password`). */
export const CACHE_SECRET_TARGET = 'cache-password';

const MB = 1024 * 1024;
const DISPATCH_TIMEOUT_MS = 60_000;
const BACKUP_TIMEOUT_MS = 600_000;
const EXEC_TIMEOUT_MS = 30_000;

// ── Naming (all derived from <stack>_<cluster>) ───────────────────────────────
export function cacheBaseName(stack: string, cluster: string): string {
  return `${stack}_${cluster}`;
}
/** `<stack>_<cluster>-cache` — the primary; also the DNS host apps connect to. */
export function cachePrimaryName(stack: string, cluster: string): string {
  return `${cacheBaseName(stack, cluster)}-cache`;
}
export function cacheReplicaName(stack: string, cluster: string): string {
  return `${cacheBaseName(stack, cluster)}-cache-replica`;
}
export function cacheSentinelName(stack: string, cluster: string): string {
  return `${cacheBaseName(stack, cluster)}-cache-sentinel`;
}
/** Per-cluster attachable overlay network joining members + attached apps. */
export function cacheNetworkName(stack: string, cluster: string): string {
  return `${cacheBaseName(stack, cluster)}-cache-net`;
}
/** The primary's data volume — the unit backup.run/backup.restore operate on. */
export function cacheDataVolume(stack: string, cluster: string): string {
  return `${cacheBaseName(stack, cluster)}-cache-data`;
}
/**
 * Docker secret carrying the cluster password: `swarmy-cache-<cluster>-password`,
 * where <cluster> is stack-qualified (secrets are swarm-global, so two stacks may
 * both have a cluster called "main").
 */
export function cachePasswordSecretName(stack: string, cluster: string): string {
  return `swarmy-cache-${cacheBaseName(stack, cluster)}-password`;
}
/** restic tag identifying the cluster's snapshots. */
export function cacheBackupTag(stack: string, cluster: string): string {
  return `cache:${cacheBaseName(stack, cluster)}`;
}
/** `REDIS_URL` → `REDIS_PASSWORD_FILE` (the secret-file companion env var). */
export function cachePasswordFileVar(envVar: string): string {
  return envVar.endsWith('_URL') ? `${envVar.slice(0, -4)}_PASSWORD_FILE` : `${envVar}_PASSWORD_FILE`;
}

/** URL-safe secret (no chars needing percent-encoding in a redis:// URL). */
function generatePassword(): string {
  return randomBytes(24).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 28);
}

/** Swarm memory limit = maxmemory + headroom so the engine isn't OOM-killed at its own cap. */
export function memoryLimitBytes(memoryMb: number): number {
  return (memoryMb + 64) * MB;
}

// ── Pure: INFO parser (tested; mirrored small in cache-reconcile.ts) ──────────

/** A parsed INFO sample (CacheStatsView minus the timestamp). */
export interface CacheInfoSample {
  usedMemoryBytes: number;
  maxMemoryBytes: number;
  connectedClients: number;
  opsPerSec: number;
  keys: number;
  hitRatePct: number | null;
}

/**
 * Parse `redis-cli INFO` / `valkey-cli INFO` output into the stats sample.
 * Tolerant of CRLF, comment sections and missing fields; returns null when the
 * payload does not look like an INFO dump (no `used_memory`).
 */
export function parseCacheInfo(raw: string): CacheInfoSample | null {
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
    // Keyspace section: dbN:keys=10,expires=2,avg_ttl=0
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

/** Encode a stats sample for the `swarmy.cache.stats` label (stable field order). */
export function encodeStatsLabel(stats: CacheStatsView): string {
  return JSON.stringify({
    usedMemoryBytes: stats.usedMemoryBytes,
    maxMemoryBytes: stats.maxMemoryBytes,
    connectedClients: stats.connectedClients,
    opsPerSec: stats.opsPerSec,
    keys: stats.keys,
    hitRatePct: stats.hitRatePct,
    at: stats.at,
  });
}

/** Parse the stats label; malformed/foreign JSON degrades to null (no throw). */
export function parseStatsLabel(raw: string | undefined | null): CacheStatsView | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<CacheStatsView>;
    if (typeof v.usedMemoryBytes !== 'number' || typeof v.at !== 'string') return null;
    return {
      usedMemoryBytes: v.usedMemoryBytes,
      maxMemoryBytes: typeof v.maxMemoryBytes === 'number' ? v.maxMemoryBytes : 0,
      connectedClients: typeof v.connectedClients === 'number' ? v.connectedClients : 0,
      opsPerSec: typeof v.opsPerSec === 'number' ? v.opsPerSec : 0,
      keys: typeof v.keys === 'number' ? v.keys : 0,
      hitRatePct: typeof v.hitRatePct === 'number' ? v.hitRatePct : null,
      at: v.at,
    };
  } catch {
    return null;
  }
}

/** Parse `swarmy.cache.region.<region>.replicas` labels → { region: count }. */
export function parseCacheRegionReplicas(labels: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(labels)) {
    const m = CACHE_REGION_REPLICAS_RE.exec(key);
    if (!m) continue;
    const region = m[1];
    const n = Number.parseInt(value, 10);
    if (!region || Number.isNaN(n) || n < 0) continue;
    out[region] = n;
  }
  return out;
}

/** Read the cluster's topology off a member's labels (default single). */
export function cacheTopologyOf(labels: Record<string, string> | undefined): CacheTopology {
  const v = labels?.[CACHE_TOPOLOGY_LABEL];
  return (CACHE_TOPOLOGIES as readonly string[]).includes(v ?? '')
    ? (v as CacheTopology)
    : DEFAULT_CACHE_TOPOLOGY;
}

function cacheEngineOf(labels: Record<string, string> | undefined): CacheEngine {
  return labels?.[CACHE_ENGINE_LABEL] === 'redis' ? 'redis' : 'valkey';
}

// ── Pure: topology diff planner (tested; mirrored in cache-reconcile.ts) ──────

/** The declared shape of a cluster, read off its anchor (primary) labels. */
export interface CacheDeclaredState {
  topology: CacheTopology;
  replicas: number;
  memoryMb: number;
  /** region → declared replica count. */
  regionReplicas: Record<string, number>;
}

/** One live member as the planner sees it (name + desired + applied memory). */
export interface CacheLiveMember {
  name: string;
  desired: number;
  /** `swarmy.cache.appliedMemoryMb`, or null when unlabelled. */
  appliedMemoryMb: number | null;
}

export interface CacheLiveState {
  primary?: CacheLiveMember;
  replica?: CacheLiveMember;
  sentinel?: CacheLiveMember;
  /** region → live region-pinned replica sibling. */
  regionReplicas: Record<string, CacheLiveMember>;
}

export type CachePlanAction =
  | { kind: 'deploy-replica'; replicas: number }
  | { kind: 'deploy-sentinel' }
  | { kind: 'deploy-region-replica'; region: string; replicas: number }
  | { kind: 'scale'; service: string; replicas: number }
  | { kind: 'remove'; service: string }
  | { kind: 'redeploy-memory'; service: string };

/**
 * Diff a cluster's declared topology against its live member set → the actions
 * that converge it. Pure — the reconcile worker executes the plan with the spec
 * builders below. Sentinel failover needs a replica to promote to, so the
 * replica floor is 1 under `sentinel`.
 */
export function planCacheConvergence(
  decl: CacheDeclaredState,
  live: CacheLiveState,
): CachePlanAction[] {
  const actions: CachePlanAction[] = [];
  const replicaTarget =
    decl.topology === 'single'
      ? 0
      : decl.topology === 'sentinel'
        ? Math.max(1, decl.replicas)
        : decl.replicas;

  // (1) Base read-replica service: create / scale / park at 0.
  if (!live.replica) {
    if (replicaTarget > 0) actions.push({ kind: 'deploy-replica', replicas: replicaTarget });
  } else if (live.replica.desired !== replicaTarget) {
    actions.push({ kind: 'scale', service: live.replica.name, replicas: replicaTarget });
  }

  // (2) Sentinel trio: exists exactly under the sentinel topology.
  if (decl.topology === 'sentinel') {
    if (!live.sentinel) actions.push({ kind: 'deploy-sentinel' });
    else if (live.sentinel.desired !== SENTINEL_COUNT) {
      actions.push({ kind: 'scale', service: live.sentinel.name, replicas: SENTINEL_COUNT });
    }
  } else if (live.sentinel) {
    actions.push({ kind: 'remove', service: live.sentinel.name });
  }

  // (3) Region-pinned replica siblings (declared on the primary's labels).
  for (const [region, n] of Object.entries(decl.regionReplicas)) {
    const sib = live.regionReplicas[region];
    if (n <= 0) {
      if (sib) actions.push({ kind: 'remove', service: sib.name });
      continue;
    }
    if (!sib) actions.push({ kind: 'deploy-region-replica', region, replicas: n });
    else if (sib.desired !== n) actions.push({ kind: 'scale', service: sib.name, replicas: n });
  }
  for (const [region, sib] of Object.entries(live.regionReplicas)) {
    if (!(region in decl.regionReplicas)) actions.push({ kind: 'remove', service: sib.name });
  }

  // (4) Memory drift: any data member deployed with a different maxmemory.
  for (const member of [live.primary, live.replica, ...Object.values(live.regionReplicas)]) {
    if (!member) continue;
    if (member.appliedMemoryMb !== null && member.appliedMemoryMb !== decl.memoryMb) {
      actions.push({ kind: 'redeploy-memory', service: member.name });
    }
  }
  return actions;
}

// ── Spec builders (canonical; mirrored in cache-reconcile.ts) ─────────────────

export interface CacheClusterDecl {
  stack: string;
  cluster: string;
  engine: CacheEngine;
  topology: CacheTopology;
  memoryMb: number;
  replicas: number;
  /** Stamped verbatim as `swarmy.cache.region.<r>.replicas` on the primary. */
  regionReplicas?: Record<string, number>;
}

function cacheLabels(
  decl: CacheClusterDecl,
  role: CacheRole,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    [MANAGED_LABEL]: 'true',
    [STACK_LABEL]: decl.stack,
    [CACHE_ENGINE_LABEL]: decl.engine,
    [CACHE_CLUSTER_LABEL]: decl.cluster,
    [CACHE_ROLE_LABEL]: role,
    [CACHE_TOPOLOGY_LABEL]: decl.topology,
    [CACHE_MEMORY_LABEL]: String(decl.memoryMb),
    [CACHE_REPLICAS_LABEL]: String(decl.replicas),
    // Caches must stay warm — the idle sleeper must never scale them to 0.
    [SCALE_TO_ZERO_EXEMPT_LABEL]: 'true',
    ...(role === 'sentinel' ? {} : { [CACHE_APPLIED_MEMORY_LABEL]: String(decl.memoryMb) }),
    ...extra,
  };
}

/**
 * The password never appears in the spec: members mount the Docker secret at
 * `/run/secrets/cache-password` and read it at start — valkey via a `sh -c`
 * wrapper (`--requirepass "$(cat …)"`), bitnami images via `*_PASSWORD_FILE`.
 */
function secretRef(decl: CacheClusterDecl): NonNullable<ServiceSpec['secrets']> {
  return [
    { source: cachePasswordSecretName(decl.stack, decl.cluster), target: CACHE_SECRET_TARGET },
  ];
}

/** valkey server command reading the password from the mounted secret file. */
function valkeyCommand(decl: CacheClusterDecl, replicaOf?: string): string {
  const parts = [
    'exec valkey-server',
    '--requirepass "$(cat /run/secrets/cache-password)"',
    '--masterauth "$(cat /run/secrets/cache-password)"',
    `--maxmemory ${decl.memoryMb}mb`,
    '--maxmemory-policy allkeys-lru',
    '--appendonly yes',
    '--dir /data',
  ];
  if (replicaOf) parts.push(`--replicaof ${replicaOf} ${CACHE_PORT}`);
  return parts.join(' ');
}

/** bitnami/redis env reading the password from the mounted secret file. */
function redisEnv(
  decl: CacheClusterDecl,
  mode: 'master' | 'slave',
  primaryHost?: string,
): Record<string, string> {
  return {
    REDIS_REPLICATION_MODE: mode,
    REDIS_PASSWORD_FILE: `/run/secrets/${CACHE_SECRET_TARGET}`,
    REDIS_MASTER_PASSWORD_FILE: `/run/secrets/${CACHE_SECRET_TARGET}`,
    REDIS_AOF_ENABLED: 'yes',
    REDIS_EXTRA_FLAGS: `--maxmemory ${decl.memoryMb}mb --maxmemory-policy allkeys-lru`,
    ...(mode === 'slave' && primaryHost
      ? { REDIS_MASTER_HOST: primaryHost, REDIS_MASTER_PORT_NUMBER: String(CACHE_PORT) }
      : {}),
  };
}

/** A data member (primary or replica). NO ports — private-only, always. */
function dataMemberSpec(
  decl: CacheClusterDecl,
  role: 'primary' | 'replica',
  opts: { name: string; replicas: number; extraLabels?: Record<string, string>; placement?: ServiceSpec['placement'] },
): ServiceSpec {
  const primary = cachePrimaryName(decl.stack, decl.cluster);
  const isPrimary = role === 'primary';
  const base: ServiceSpec = {
    name: opts.name,
    image: CACHE_IMAGES[decl.engine],
    mode: { replicated: { replicas: opts.replicas } },
    labels: cacheLabels(decl, role, opts.extraLabels),
    networks: [cacheNetworkName(decl.stack, decl.cluster)],
    secrets: secretRef(decl),
    resources: { limits: { memoryBytes: memoryLimitBytes(decl.memoryMb) } },
    // Only the primary persists — its volume is the backup/restore unit.
    ...(isPrimary
      ? {
          mounts: [
            {
              type: 'volume' as const,
              source: cacheDataVolume(decl.stack, decl.cluster),
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
      args: [valkeyCommand(decl, isPrimary ? undefined : primary)],
    };
  }
  return { ...base, env: redisEnv(decl, isPrimary ? 'master' : 'slave', primary) };
}

export function cachePrimarySpec(decl: CacheClusterDecl): ServiceSpec {
  const regionLabels: Record<string, string> = {};
  for (const [region, n] of Object.entries(decl.regionReplicas ?? {})) {
    if (n > 0) regionLabels[cacheRegionReplicasLabelKey(region)] = String(n);
  }
  return dataMemberSpec(decl, 'primary', {
    name: cachePrimaryName(decl.stack, decl.cluster),
    replicas: 1,
    extraLabels: regionLabels,
  });
}

export function cacheReplicaSpec(decl: CacheClusterDecl, replicas: number): ServiceSpec {
  return dataMemberSpec(decl, 'replica', {
    name: cacheReplicaName(decl.stack, decl.cluster),
    replicas,
    placement: { preferences: ['spread=node.id'] },
  });
}

/** A region-pinned replica sibling (mirrors manageddb's geo placement model). */
export function cacheRegionReplicaSpec(
  decl: CacheClusterDecl,
  region: string,
  replicas: number,
): ServiceSpec {
  return dataMemberSpec(decl, 'replica', {
    name: `${cacheReplicaName(decl.stack, decl.cluster)}-${region}`,
    replicas,
    extraLabels: { [CACHE_REGION_LABEL]: region },
    placement: { constraints: [`node.labels.${REGION_NODE_LABEL}==${region}`] },
  });
}

/** The 3-member sentinel trio (quorum 2) arbitrating automatic failover. */
export function cacheSentinelSpec(decl: CacheClusterDecl): ServiceSpec {
  const primary = cachePrimaryName(decl.stack, decl.cluster);
  return {
    name: cacheSentinelName(decl.stack, decl.cluster),
    image: SENTINEL_IMAGE,
    mode: { replicated: { replicas: SENTINEL_COUNT } },
    env: {
      REDIS_MASTER_HOST: primary,
      REDIS_MASTER_PORT_NUMBER: String(CACHE_PORT),
      REDIS_MASTER_SET: decl.cluster,
      REDIS_SENTINEL_QUORUM: String(SENTINEL_QUORUM),
      REDIS_MASTER_PASSWORD_FILE: `/run/secrets/${CACHE_SECRET_TARGET}`,
    },
    labels: cacheLabels(decl, 'sentinel'),
    networks: [cacheNetworkName(decl.stack, decl.cluster)],
    secrets: secretRef(decl),
    placement: { preferences: ['spread=node.id'] },
  };
}

// ── Live cluster discovery (hub inventory — never the DB) ─────────────────────

interface LiveCluster {
  stack: string;
  name: string;
  primary?: InvService;
  replica?: InvService;
  sentinel?: InvService;
  /** region → region-pinned replica sibling. */
  regionSiblings: Map<string, InvService>;
  members: InvService[];
}

function liveOrgServices(ctx: OrgContext): InvService[] {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  return buildInventory(services, containers).services;
}

function groupClusters(services: InvService[]): LiveCluster[] {
  const byKey = new Map<string, LiveCluster>();
  for (const s of services) {
    const cluster = s.labels[CACHE_CLUSTER_LABEL];
    if (!cluster || !s.labels[CACHE_ENGINE_LABEL]) continue;
    const stack = s.labels[STACK_LABEL] ?? s.stack;
    const key = `${stack} ${cluster}`;
    const c =
      byKey.get(key) ??
      ({ stack, name: cluster, regionSiblings: new Map(), members: [] } as LiveCluster);
    c.members.push(s);
    const role = s.labels[CACHE_ROLE_LABEL];
    const region = s.labels[CACHE_REGION_LABEL];
    if (role === 'primary') c.primary = s;
    else if (role === 'sentinel') c.sentinel = s;
    else if (role === 'replica') {
      if (region) c.regionSiblings.set(region, s);
      else c.replica = s;
    }
    byKey.set(key, c);
  }
  return [...byKey.values()];
}

function findCluster(ctx: OrgContext, stack: string, cluster: string): LiveCluster | undefined {
  return groupClusters(liveOrgServices(ctx)).find((c) => c.stack === stack && c.name === cluster);
}

function requireCluster(ctx: OrgContext, stack: string, cluster: string): LiveCluster {
  const c = findCluster(ctx, stack, cluster);
  if (!c) throw notFound('cache cluster', `${stack}/${cluster}`);
  return c;
}

/** Rebuild the declared shape from a live cluster's anchor labels. */
function declOf(c: LiveCluster): CacheClusterDecl {
  const anchor = c.primary?.labels ?? c.members[0]?.labels ?? {};
  const memory = Number.parseInt(anchor[CACHE_MEMORY_LABEL] ?? '', 10);
  const replicas = Number.parseInt(anchor[CACHE_REPLICAS_LABEL] ?? '', 10);
  return {
    stack: c.stack,
    cluster: c.name,
    engine: cacheEngineOf(anchor),
    topology: cacheTopologyOf(anchor),
    memoryMb: Number.isFinite(memory) && memory > 0 ? memory : 256,
    replicas: Number.isFinite(replicas) && replicas >= 0 ? replicas : 0,
    regionReplicas: parseCacheRegionReplicas(anchor),
  };
}

// ── View projection ───────────────────────────────────────────────────────────

function toView(ctx: OrgContext, c: LiveCluster): CacheClusterView {
  const decl = declOf(c);
  const host = c.primary?.name ?? cachePrimaryName(c.stack, c.name);
  const memberViews: CacheMemberView[] = c.members
    .map((s): CacheMemberView => {
      const role = s.labels[CACHE_ROLE_LABEL];
      return {
        service: s.name,
        role: role === 'primary' || role === 'sentinel' ? role : 'replica',
        ...(s.labels[CACHE_REGION_LABEL] ? { region: s.labels[CACHE_REGION_LABEL] } : {}),
        status: s.status,
        desired: s.replicas.desired,
        running: s.replicas.running,
      };
    })
    .sort((a, b) => a.service.localeCompare(b.service));

  // Replica totals include region-pinned siblings so the card reads the truth.
  const replicaMembers = [c.replica, ...c.regionSiblings.values()].filter(
    (s): s is InvService => Boolean(s),
  );
  const attachments: CacheAttachmentView[] = liveOrgServices(ctx)
    .filter((s) => s.stack === c.stack && s.labels[CACHE_INJECT_LABEL] === c.name)
    .map((s) => ({ service: s.name, envVar: s.labels[CACHE_INJECT_VAR_LABEL] ?? 'REDIS_URL' }))
    .sort((a, b) => a.service.localeCompare(b.service));

  return {
    stack: c.stack,
    name: c.name,
    engine: decl.engine,
    topology: decl.topology,
    memoryMb: decl.memoryMb,
    declaredReplicas: decl.replicas,
    primary: { service: host, status: c.primary?.status ?? 'absent' },
    replicas: {
      desired: replicaMembers.reduce((n, s) => n + s.replicas.desired, 0),
      running: replicaMembers.reduce((n, s) => n + s.replicas.running, 0),
    },
    sentinels: {
      desired: c.sentinel?.replicas.desired ?? 0,
      running: c.sentinel?.replicas.running ?? 0,
    },
    host,
    port: CACHE_PORT,
    passwordSecret: cachePasswordSecretName(c.stack, c.name),
    members: memberViews,
    ...(Object.keys(decl.regionReplicas ?? {}).length > 0
      ? { regionReplicas: decl.regionReplicas }
      : {}),
    stats: parseStatsLabel(c.primary?.labels[CACHE_STATS_LABEL]),
    attachments,
  };
}

/** Managed cache clusters — org-wide, or scoped to one stack when given. */
export function listCacheClusters(ctx: OrgContext, stack?: string): CacheClusterView[] {
  return groupClusters(liveOrgServices(ctx))
    .map((c) => toView(ctx, c))
    .filter((v) => !stack || v.stack === stack)
    .sort((a, b) => `${a.stack}/${a.name}`.localeCompare(`${b.stack}/${b.name}`));
}

/** One cluster's topology view, straight off the labels. */
export function getCacheCluster(
  ctx: OrgContext,
  input: { stack: string; cluster: string },
): CacheClusterView {
  return toView(ctx, requireCluster(ctx, input.stack, input.cluster));
}

// ── Mutations ─────────────────────────────────────────────────────────────────

/**
 * Provision a managed cache cluster. The password is generated once, created as
 * a Docker secret (`secret.create`), and returned ONCE here — it is never
 * persisted controller-side and never retrievable again.
 */
export async function provisionCache(
  ctx: OrgContext,
  input: ProvisionCacheInput,
): Promise<CacheProvisionResult> {
  const stack = input.stack.trim();
  const cluster = input.name.trim();
  if (!stack || !cluster) throw commandRejected('stack and name are required');
  if (findCluster(ctx, stack, cluster)) {
    throw commandRejected(`cache cluster "${cluster}" already exists in stack "${stack}"`);
  }
  if (input.topology === 'sentinel' && input.replicas < 1) {
    // Sentinel failover needs a replica to promote — hold the floor at 1.
    input = { ...input, replicas: 1 };
  }
  const decl: CacheClusterDecl = {
    stack,
    cluster,
    engine: input.engine,
    topology: input.topology,
    memoryMb: input.memoryMb,
    replicas: input.replicas,
    regionReplicas: Object.fromEntries(
      input.regions.filter((r) => r.replicas > 0).map((r) => [r.region.trim(), r.replicas]),
    ),
  };
  const node = await resolveManagerNode(ctx);
  const password = generatePassword();
  const secretName = cachePasswordSecretName(stack, cluster);
  const dataB64 = Buffer.from(password, 'utf8').toString('base64');
  const secretLabels = { [MANAGED_LABEL]: 'true', [CACHE_CLUSTER_LABEL]: cluster };

  try {
    await ctx.hub.dispatch(node.id, 'network.ensure', {
      name: cacheNetworkName(stack, cluster),
      driver: 'overlay',
      attachable: true,
      labels: { [MANAGED_LABEL]: 'true', [CACHE_CLUSTER_LABEL]: cluster },
    });
    try {
      await ctx.hub.dispatch(node.id, 'secret.create', { name: secretName, dataB64, labels: secretLabels });
    } catch (e) {
      // A stale secret from a previously destroyed cluster: replace it.
      if (!/already exists|conflict/i.test(e instanceof Error ? e.message : String(e))) throw e;
      await ctx.hub.dispatch(node.id, 'secret.remove', { name: secretName });
      await ctx.hub.dispatch(node.id, 'secret.create', { name: secretName, dataB64, labels: secretLabels });
    }
    await ctx.hub.dispatch(
      node.id,
      'service.deploy',
      { spec: cachePrimarySpec(decl), pullPolicy: 'always' },
      { timeoutMs: DISPATCH_TIMEOUT_MS },
    );
    if (decl.topology !== 'single' && decl.replicas > 0) {
      await ctx.hub.dispatch(
        node.id,
        'service.deploy',
        { spec: cacheReplicaSpec(decl, decl.replicas), pullPolicy: 'always' },
        { timeoutMs: DISPATCH_TIMEOUT_MS },
      );
    }
    if (decl.topology === 'sentinel') {
      await ctx.hub.dispatch(
        node.id,
        'service.deploy',
        { spec: cacheSentinelSpec(decl), pullPolicy: 'always' },
        { timeoutMs: DISPATCH_TIMEOUT_MS },
      );
    }
  } catch (e) {
    throw mapDispatchError(e);
  }

  await writeAudit(ctx, {
    action: 'cache.provision',
    targetType: 'cacheCluster',
    targetId: cacheBaseName(stack, cluster),
    metadata: {
      engine: decl.engine,
      topology: decl.topology,
      memoryMb: decl.memoryMb,
      replicas: decl.replicas,
      regions: Object.keys(decl.regionReplicas ?? {}),
    },
  });

  if (input.attachService) {
    // Best-effort: a failed attach must not lose the one-time password reveal —
    // the cluster exists and the app can be attached again from the panel.
    await attachCacheToService(ctx, {
      stack,
      cluster,
      appService: input.attachService,
      envVar: 'REDIS_URL',
    }).catch(() => undefined);
  }

  return {
    stack,
    cluster,
    engine: decl.engine,
    topology: decl.topology,
    host: cachePrimaryName(stack, cluster),
    port: CACHE_PORT,
    passwordSecret: secretName,
    password,
  };
}

/**
 * Scale read replicas to N. Stamps the declared `swarmy.cache.replicas` label
 * (the reconcile target) AND converges immediately for instant feedback.
 */
export async function setCacheReplicas(
  ctx: OrgContext,
  input: { stack: string; cluster: string; replicas: number },
): Promise<{ cluster: string; replicas: number }> {
  const c = requireCluster(ctx, input.stack, input.cluster);
  const decl = declOf(c);
  const replicas =
    decl.topology === 'sentinel'
      ? Math.max(1, Math.floor(input.replicas))
      : Math.max(0, Math.floor(input.replicas));
  const node = await resolveManagerNode(ctx);
  try {
    for (const svc of c.members) {
      await ctx.hub.dispatch(node.id, 'service.updateLabels', {
        service: svc.name,
        add: { [CACHE_REPLICAS_LABEL]: String(replicas) },
        removeKeys: [],
      });
    }
    if (c.replica) {
      await ctx.hub.dispatch(node.id, 'service.scale', { service: c.replica.name, replicas });
    } else if (replicas > 0 && decl.topology !== 'single') {
      await ctx.hub.dispatch(
        node.id,
        'service.deploy',
        { spec: cacheReplicaSpec({ ...decl, replicas }, replicas), pullPolicy: 'always' },
        { timeoutMs: DISPATCH_TIMEOUT_MS },
      );
    }
  } catch (e) {
    throw mapDispatchError(e);
  }
  await writeAudit(ctx, {
    action: 'cache.setReplicas',
    targetType: 'cacheCluster',
    targetId: cacheBaseName(input.stack, input.cluster),
    metadata: { replicas },
  });
  return { cluster: input.cluster, replicas };
}

/**
 * Change maxmemory. Redeploys data members with the new `--maxmemory` + swarm
 * resource limit (specs are rebuilt canonically from labels, stamping both
 * `swarmy.cache.memoryMb` and `swarmy.cache.appliedMemoryMb`).
 */
export async function setCacheMemory(
  ctx: OrgContext,
  input: { stack: string; cluster: string; memoryMb: number },
): Promise<{ cluster: string; memoryMb: number }> {
  const memoryMb = Math.floor(input.memoryMb);
  if (memoryMb < 64) throw commandRejected('memoryMb must be at least 64');
  const c = requireCluster(ctx, input.stack, input.cluster);
  const decl = { ...declOf(c), memoryMb };
  const node = await resolveManagerNode(ctx);
  try {
    await ctx.hub.dispatch(
      node.id,
      'service.deploy',
      { spec: cachePrimarySpec(decl), pullPolicy: 'missing' },
      { timeoutMs: DISPATCH_TIMEOUT_MS },
    );
    if (c.replica) {
      await ctx.hub.dispatch(
        node.id,
        'service.deploy',
        { spec: cacheReplicaSpec(decl, c.replica.replicas.desired), pullPolicy: 'missing' },
        { timeoutMs: DISPATCH_TIMEOUT_MS },
      );
    }
    for (const [region, sib] of c.regionSiblings) {
      await ctx.hub.dispatch(
        node.id,
        'service.deploy',
        { spec: cacheRegionReplicaSpec(decl, region, sib.replicas.desired), pullPolicy: 'missing' },
        { timeoutMs: DISPATCH_TIMEOUT_MS },
      );
    }
    // Sentinels don't carry maxmemory, but keep their declared label coherent.
    if (c.sentinel) {
      await ctx.hub.dispatch(node.id, 'service.updateLabels', {
        service: c.sentinel.name,
        add: { [CACHE_MEMORY_LABEL]: String(memoryMb) },
        removeKeys: [],
      });
    }
  } catch (e) {
    throw mapDispatchError(e);
  }
  await writeAudit(ctx, {
    action: 'cache.setMemory',
    targetType: 'cacheCluster',
    targetId: cacheBaseName(input.stack, input.cluster),
    metadata: { memoryMb },
  });
  return { cluster: input.cluster, memoryMb };
}

/**
 * Destroy a cluster: remove every member service + the password secret.
 * Refused while apps are still attached (unless `force`). The data volume and
 * overlay network are left behind on purpose — volumes may hold the last
 * snapshot and there is no network-remove command; both are inert without the
 * services.
 */
export async function destroyCache(
  ctx: OrgContext,
  input: { stack: string; cluster: string; force?: boolean },
): Promise<{ cluster: string; removed: true }> {
  const c = requireCluster(ctx, input.stack, input.cluster);
  const attached = liveOrgServices(ctx).filter(
    (s) => s.stack === c.stack && s.labels[CACHE_INJECT_LABEL] === c.name,
  );
  if (attached.length > 0 && !input.force) {
    throw commandRejected(
      `${attached.length} service(s) still attached (${attached
        .map((s) => s.name)
        .join(', ')}) — detach them first or pass force`,
    );
  }
  const node = await resolveManagerNode(ctx);
  try {
    for (const svc of c.members) {
      await ctx.hub.dispatch(node.id, 'service.remove', { service: svc.name });
    }
  } catch (e) {
    throw mapDispatchError(e);
  }
  // Best-effort: a failed secret removal must not block the destroy.
  await ctx.hub
    .dispatch(node.id, 'secret.remove', { name: cachePasswordSecretName(c.stack, c.name) })
    .catch(() => undefined);
  await writeAudit(ctx, {
    action: 'cache.destroy',
    targetType: 'cacheCluster',
    targetId: cacheBaseName(input.stack, input.cluster),
    metadata: { force: Boolean(input.force), members: c.members.map((s) => s.name) },
  });
  return { cluster: input.cluster, removed: true };
}

/**
 * Wire an app service to the cluster: attach it to the cluster overlay network,
 * mount the password Docker secret, and set `<VAR>=redis://<primary>:6379` plus
 * `<VAR-prefix>_PASSWORD_FILE=/run/secrets/<secret>`. The password itself never
 * leaves Docker — the app reads it from the secret file (mirrors manageddb
 * injectConnection, same lossy-merge caveat: mounts/constraints are not exposed
 * by the live inventory and are not re-applied here).
 */
export async function attachCacheToService(
  ctx: OrgContext,
  input: AttachCacheInput,
): Promise<{ appService: string; cluster: string; envVar: string; url: string; passwordFileVar: string }> {
  const envVar = input.envVar?.trim() || 'REDIS_URL';
  const c = requireCluster(ctx, input.stack, input.cluster);
  const host = c.primary?.name ?? cachePrimaryName(input.stack, input.cluster);
  const app = liveOrgServices(ctx).find(
    (s) => s.stack === input.stack && (s.id === input.appService || s.name === input.appService),
  );
  if (!app) throw notFound('service', input.appService);

  const secretName = cachePasswordSecretName(input.stack, input.cluster);
  const passwordFileVar = cachePasswordFileVar(envVar);
  const url = `redis://${host}:${CACHE_PORT}`;
  const network = cacheNetworkName(input.stack, input.cluster);

  const env: Record<string, string> = {};
  for (const kv of app.env) {
    const i = kv.indexOf('=');
    env[i >= 0 ? kv.slice(0, i) : kv] = i >= 0 ? kv.slice(i + 1) : '';
  }
  env[envVar] = url;
  env[passwordFileVar] = `/run/secrets/${secretName}`;

  const secrets = [
    ...(app.secrets ?? []).filter((n) => n !== secretName).map((n) => ({ source: n })),
    { source: secretName },
  ];
  const spec: ServiceSpec = {
    name: app.name,
    image: app.image,
    mode: { replicated: { replicas: app.replicas.desired } },
    labels: {
      ...app.labels,
      [STACK_LABEL]: input.stack,
      [CACHE_INJECT_LABEL]: input.cluster,
      [CACHE_INJECT_VAR_LABEL]: envVar,
    },
    env,
    ports: app.ports.map((p) => ({
      target: p.target,
      published: p.published,
      protocol: p.protocol === 'udp' ? ('udp' as const) : ('tcp' as const),
      mode: 'ingress' as const,
    })),
    networks: Array.from(new Set([...app.networks.map((n) => n.name), network])),
    secrets,
    ...(app.configs && app.configs.length > 0
      ? { configs: app.configs.map((n) => ({ source: n })) }
      : {}),
  };

  const node = await resolveManagerNode(ctx);
  try {
    await ctx.hub.dispatch(node.id, 'service.deploy', { spec, pullPolicy: 'missing' });
  } catch (e) {
    throw mapDispatchError(e);
  }
  await writeAudit(ctx, {
    action: 'cache.attach',
    targetType: 'cacheCluster',
    targetId: cacheBaseName(input.stack, input.cluster),
    metadata: { appService: app.name, envVar },
  });
  return { appService: app.name, cluster: input.cluster, envVar, url, passwordFileVar };
}

/** Unwire an app: drop the env vars, secret ref, network and inject labels. */
export async function detachCacheFromService(
  ctx: OrgContext,
  input: { stack: string; cluster: string; appService: string },
): Promise<{ appService: string; cluster: string; detached: true }> {
  requireCluster(ctx, input.stack, input.cluster);
  const app = liveOrgServices(ctx).find(
    (s) => s.stack === input.stack && (s.id === input.appService || s.name === input.appService),
  );
  if (!app) throw notFound('service', input.appService);
  if (app.labels[CACHE_INJECT_LABEL] !== input.cluster) {
    throw commandRejected(`service "${app.name}" is not attached to "${input.cluster}"`);
  }

  const envVar = app.labels[CACHE_INJECT_VAR_LABEL] ?? 'REDIS_URL';
  const passwordFileVar = cachePasswordFileVar(envVar);
  const secretName = cachePasswordSecretName(input.stack, input.cluster);
  const network = cacheNetworkName(input.stack, input.cluster);

  const env: Record<string, string> = {};
  for (const kv of app.env) {
    const i = kv.indexOf('=');
    const key = i >= 0 ? kv.slice(0, i) : kv;
    if (key === envVar || key === passwordFileVar) continue;
    env[key] = i >= 0 ? kv.slice(i + 1) : '';
  }
  const labels = { ...app.labels };
  delete labels[CACHE_INJECT_LABEL];
  delete labels[CACHE_INJECT_VAR_LABEL];

  const spec: ServiceSpec = {
    name: app.name,
    image: app.image,
    mode: { replicated: { replicas: app.replicas.desired } },
    labels,
    env,
    ports: app.ports.map((p) => ({
      target: p.target,
      published: p.published,
      protocol: p.protocol === 'udp' ? ('udp' as const) : ('tcp' as const),
      mode: 'ingress' as const,
    })),
    networks: app.networks.map((n) => n.name).filter((n) => n !== network),
    secrets: (app.secrets ?? []).filter((n) => n !== secretName).map((n) => ({ source: n })),
    ...(app.configs && app.configs.length > 0
      ? { configs: app.configs.map((n) => ({ source: n })) }
      : {}),
  };

  const node = await resolveManagerNode(ctx);
  try {
    await ctx.hub.dispatch(node.id, 'service.deploy', { spec, pullPolicy: 'missing' });
  } catch (e) {
    throw mapDispatchError(e);
  }
  await writeAudit(ctx, {
    action: 'cache.detach',
    targetType: 'cacheCluster',
    targetId: cacheBaseName(input.stack, input.cluster),
    metadata: { appService: app.name },
  });
  return { appService: app.name, cluster: input.cluster, detached: true };
}

// ── Stats (live INFO via exec; label stamp as fallback) ───────────────────────

/** Shell command reading INFO with the password from the mounted secret file. */
export function cacheInfoCommand(engine: CacheEngine): string {
  const cli = engine === 'redis' ? 'redis-cli' : 'valkey-cli';
  return `${cli} --no-auth-warning -a "$(cat /run/secrets/${CACHE_SECRET_TARGET})" INFO`;
}

/**
 * Live INFO sample from the primary via the `exec` command (the container holds
 * the password secret — nothing rides the wire). Falls back to the
 * `swarmy.cache.stats` label the reconcile worker stamps.
 */
export async function cacheStats(
  ctx: OrgContext,
  input: { stack: string; cluster: string },
): Promise<CacheStatsView | null> {
  const c = requireCluster(ctx, input.stack, input.cluster);
  const fallback = parseStatsLabel(c.primary?.labels[CACHE_STATS_LABEL]);
  if (!c.primary) return fallback;
  const target = resolveExecTarget(ctx, c.primary.name);
  if (!target) return fallback;
  try {
    const res = await ctx.hub.dispatch<{ exitCode: number; output?: string }>(
      target.nodeId,
      'exec',
      {
        target: { containerId: target.containerId },
        cmd: ['sh', '-c', cacheInfoCommand(declOf(c).engine)],
        tty: false,
        stream: false,
      },
      { timeoutMs: EXEC_TIMEOUT_MS },
    );
    if (res.exitCode !== 0 || !res.output) return fallback;
    const sample = parseCacheInfo(res.output);
    return sample ? { ...sample, at: new Date().toISOString() } : fallback;
  } catch {
    return fallback;
  }
}

// ── Backups (BGSAVE + restic volume snapshot tagged cache:<cluster>) ──────────
// Target → repo mirrors backups.service / dbBackup.service (org-scoped rows,
// secrets vault-decrypted just-in-time, never persisted on the node).

interface TargetRow {
  id: string;
  kind: string;
  endpoint: string | null;
  bucket: string;
  prefix: string | null;
  region: string | null;
  credentialRef: string | null;
  secretKeyRef: string | null;
  resticPasswordRef: string;
}

async function resolveTarget(ctx: OrgContext, explicit?: string): Promise<TargetRow> {
  if (explicit) {
    const row = (await ctx.db.backupTarget.findFirst({
      where: { id: explicit, orgId: ctx.activeOrgId },
    })) as unknown as TargetRow | null;
    if (!row) throw notFound('backup target', explicit);
    return row;
  }
  const first = (await ctx.db.backupTarget.findFirst({
    where: { orgId: ctx.activeOrgId, enabled: true },
    orderBy: { createdAt: 'asc' },
  })) as unknown as TargetRow | null;
  if (!first) {
    throw commandRejected('no backup destination configured — add one on the Backups page');
  }
  return first;
}

function toResticRepo(row: TargetRow): ResticRepo {
  const prefix = row.prefix ? `/${row.prefix.replace(/^\/+/, '')}` : '';
  const isNode = row.kind === 'node' || row.kind === 'NODE';
  const repo = isNode
    ? `${row.bucket.replace(/\/+$/, '')}${prefix}`
    : `s3:${(row.endpoint ?? '').replace(/\/+$/, '')}/${row.bucket}${prefix}`;
  return {
    kind: isNode ? 'node' : 's3',
    repo,
    password: decryptSecret(row.resticPasswordRef),
    endpoint: row.endpoint ?? undefined,
    region: row.region ?? undefined,
    accessKeyId: row.credentialRef ? decryptSecret(row.credentialRef) : undefined,
    secretAccessKey: row.secretKeyRef ? decryptSecret(row.secretKeyRef) : undefined,
  };
}

/** Best-effort BGSAVE (flush an RDB snapshot) before the volume backup. */
async function bgsavePrimary(ctx: OrgContext, c: LiveCluster): Promise<void> {
  if (!c.primary) return;
  const target = resolveExecTarget(ctx, c.primary.name);
  if (!target) return;
  const cli = declOf(c).engine === 'redis' ? 'redis-cli' : 'valkey-cli';
  const auth = `--no-auth-warning -a "$(cat /run/secrets/${CACHE_SECRET_TARGET})"`;
  // BGSAVE, then wait (bounded) until the background save finishes.
  const script = `${cli} ${auth} BGSAVE; for i in 1 2 3 4 5 6 7 8 9 10; do [ "$(${cli} ${auth} INFO persistence | grep -c rdb_bgsave_in_progress:1)" = "0" ] && break; sleep 1; done`;
  await ctx.hub
    .dispatch(
      target.nodeId,
      'exec',
      { target: { containerId: target.containerId }, cmd: ['sh', '-c', script], tty: false, stream: false },
      { timeoutMs: EXEC_TIMEOUT_MS },
    )
    .catch(() => undefined);
}

/** Snapshot the cluster's data volume (BGSAVE → restic backup.run). */
export async function backupCache(
  ctx: OrgContext,
  input: { stack: string; cluster: string; targetId?: string; retentionDays?: number },
): Promise<{ resticId: string; sizeBytes: string }> {
  const c = requireCluster(ctx, input.stack, input.cluster);
  const target = await resolveTarget(ctx, input.targetId);
  const node = await resolveManagerNode(ctx);
  const volume = cacheDataVolume(input.stack, input.cluster);
  // Explicit override wins; otherwise the stack's volume-retention label
  // (`swarmy.backup.retentionDays`) applies — cache volumes are stack volumes.
  const retentionDays =
    input.retentionDays ?? stackRetentionFor(liveOrgServices(ctx), volume) ?? undefined;
  await bgsavePrimary(ctx, c);
  try {
    const result = await ctx.hub.dispatch<BackupVolumeResult>(
      node.id,
      'backup.run',
      {
        jobId: `cache-${cacheBaseName(input.stack, input.cluster)}-${Date.now()}`,
        repo: toResticRepo(target),
        volume,
        tags: [
          `org:${ctx.activeOrgId}`,
          `volume:${volume}`,
          cacheBackupTag(input.stack, input.cluster),
        ],
        retentionDays,
      },
      { timeoutMs: BACKUP_TIMEOUT_MS },
    );
    await writeAudit(ctx, {
      action: 'cache.backup',
      targetType: 'cacheCluster',
      targetId: cacheBaseName(input.stack, input.cluster),
      metadata: { targetId: target.id, resticId: result.snapshotId, volume },
    });
    await auditRetentionOutcome(
      ctx,
      {
        targetType: 'cacheCluster',
        targetId: cacheBaseName(input.stack, input.cluster),
        volume,
      },
      result.retention,
    );
    return { resticId: result.snapshotId, sizeBytes: String(result.sizeBytes) };
  } catch (e) {
    throw mapDispatchError(e);
  }
}

/**
 * Restore a snapshot into the cluster's data volume: stop the primary (scale 0),
 * `backup.restore`, then start it again — the engine reloads the restored dump.
 * The primary is restarted even when the restore fails (old data intact).
 */
export async function restoreCache(
  ctx: OrgContext,
  input: { stack: string; cluster: string; snapshotId: string; targetId?: string },
): Promise<{ cluster: string; bytesRestored: string }> {
  const c = requireCluster(ctx, input.stack, input.cluster);
  if (!c.primary) throw notFound('cache cluster primary', input.cluster);
  const target = await resolveTarget(ctx, input.targetId);
  const node = await resolveManagerNode(ctx);
  const volume = cacheDataVolume(input.stack, input.cluster);
  const primaryName = c.primary.name;

  await ctx.hub.dispatch(node.id, 'service.scale', { service: primaryName, replicas: 0 });
  let result: RestoreVolumeResult;
  try {
    result = await ctx.hub.dispatch<RestoreVolumeResult>(
      node.id,
      'backup.restore',
      { repo: toResticRepo(target), snapshotId: input.snapshotId, targetVolume: volume },
      { timeoutMs: BACKUP_TIMEOUT_MS },
    );
  } catch (e) {
    throw mapDispatchError(e);
  } finally {
    await ctx.hub
      .dispatch(node.id, 'service.scale', { service: primaryName, replicas: 1 })
      .catch(() => undefined);
  }
  await writeAudit(ctx, {
    action: 'cache.restore',
    targetType: 'cacheCluster',
    targetId: cacheBaseName(input.stack, input.cluster),
    metadata: { snapshotId: input.snapshotId, bytesRestored: result.bytesRestored },
  });
  return { cluster: input.cluster, bytesRestored: String(result.bytesRestored) };
}

/** Snapshots for this cluster (restic catalog filtered by the cache tag). */
export async function listCacheBackups(
  ctx: OrgContext,
  input: { stack: string; cluster: string; targetId?: string },
): Promise<CacheBackupView[]> {
  const target = await resolveTarget(ctx, input.targetId);
  const node = await resolveManagerNode(ctx);
  try {
    const res = await ctx.hub.dispatch<ListSnapshotsResult>(node.id, 'backup.list', {
      repo: toResticRepo(target),
      tags: [cacheBackupTag(input.stack, input.cluster)],
    });
    return res.snapshots
      .map((s) => ({
        id: s.id,
        time: s.time,
        sizeBytes: s.sizeBytes != null ? String(s.sizeBytes) : null,
        tags: s.tags,
      }))
      .sort((a, b) => b.time.localeCompare(a.time));
  } catch (e) {
    throw mapDispatchError(e);
  }
}
