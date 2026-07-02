import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { fireEvent, systemContext } from '@swarmy/trpc';
import type { ContainerInfo, SwarmServiceInfo } from '@swarmy/core/protocol';
import { hub, store } from '../gateway';

/**
 * Queue reconcile worker (slice B1).
 *
 * Every ~15s, per org, read the `swarmy.queues` JSON labels off WORKER services
 * in the live inventory, sample each queue's depths via one `redis-cli EVAL`
 * exec on the backing cache cluster's PRIMARY container (the password stays in
 * the container's mounted secret file), then:
 *   1. stamp the samples into the worker's `swarmy.queues.stats` label
 *      (cheap last-known stats for the dashboard list),
 *   2. scale the worker service to clamp(ceil(wait/scalePerJobs), min, max) —
 *      the max across its queues when several share one worker,
 *   3. fire alert events when failed jobs pile up or the backlog keeps growing
 *      beyond what maxWorkers can absorb.
 *
 * Pure Docker-truth: hub snapshot in, dispatches out, no DB rows. The label
 * codecs / key builders / scale math mirror `@swarmy/trpc` queues.service.ts
 * (the unit-tested canonical copies) — a worker cannot subpath-import an
 * internal trpc module, same constraint cache-reconcile documents.
 */

const TICK_MS = 15_000;

// ── Label scheme — kept in sync with @swarmy/trpc queues.service.ts ───────────
const QUEUES_LABEL = 'swarmy.queues';
const QUEUES_STATS_LABEL = 'swarmy.queues.stats';
const CACHE_CLUSTER_LABEL = 'swarmy.cache.cluster';
const CACHE_ROLE_LABEL = 'swarmy.cache.role';
const CACHE_ENGINE_LABEL = 'swarmy.cache.engine';
const STACK_LABEL = 'com.docker.stack.namespace';
const SWARM_SERVICE_ID_LABEL = 'com.docker.swarm.service.id';
const SECRET_TARGET = 'cache-password';

const EXEC_TIMEOUT_MS = 20_000;
/** Failed jobs at/above this fire a `queue-failed-jobs` warning. */
const FAILED_ALERT_THRESHOLD = 10;

type Convention = 'bullmq' | 'list';

interface QueueDef {
  name: string;
  cacheCluster: string;
  convention: Convention;
  listKey?: string;
  scalePerJobs: number;
  minWorkers: number;
  maxWorkers: number;
  retries: number;
  dlq: boolean;
}

interface Sample {
  wait: number;
  active: number;
  failed: number;
  delayed: number;
  ts: string;
}

// ── Mirrors of the unit-tested pure helpers in queues.service.ts ──────────────

function parseQueuesLabel(raw: string | undefined): QueueDef[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    const out: QueueDef[] = [];
    for (const v of arr) {
      if (typeof v !== 'object' || v === null) continue;
      const o = v as Record<string, unknown>;
      if (typeof o.name !== 'string' || !o.name) continue;
      if (typeof o.cacheCluster !== 'string' || !o.cacheCluster) continue;
      const num = (x: unknown, fallback: number, min: number): number => {
        const n = typeof x === 'number' ? Math.floor(x) : Number.parseInt(String(x), 10);
        return Number.isFinite(n) && n >= min ? n : fallback;
      };
      const minWorkers = num(o.minWorkers, 1, 0);
      out.push({
        name: o.name,
        cacheCluster: o.cacheCluster,
        convention: o.convention === 'list' ? 'list' : 'bullmq',
        ...(typeof o.listKey === 'string' && o.listKey ? { listKey: o.listKey } : {}),
        scalePerJobs: num(o.scalePerJobs, 100, 1),
        minWorkers,
        maxWorkers: Math.max(minWorkers, num(o.maxWorkers, 5, 1)),
        retries: num(o.retries, 3, 0),
        dlq: o.dlq !== false,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function parseStatsLabel(raw: string | undefined): Record<string, Sample> {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as Record<string, Partial<Sample>>;
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return {};
    const out: Record<string, Sample> = {};
    for (const [name, v] of Object.entries(obj)) {
      if (typeof v?.wait !== 'number' || typeof v?.ts !== 'string') continue;
      out[name] = {
        wait: v.wait,
        active: typeof v.active === 'number' ? v.active : 0,
        failed: typeof v.failed === 'number' ? v.failed : 0,
        delayed: typeof v.delayed === 'number' ? v.delayed : 0,
        ts: v.ts,
      };
    }
    return out;
  } catch {
    return {};
  }
}

function waitKey(def: QueueDef): string {
  return def.convention === 'list' ? def.listKey?.trim() || def.name : `bull:${def.name}:wait`;
}

function depthKeys(def: QueueDef): string[] {
  if (def.convention === 'list') return [waitKey(def)];
  return [
    `bull:${def.name}:wait`,
    `bull:${def.name}:active`,
    `bull:${def.name}:failed`,
    `bull:${def.name}:delayed`,
  ];
}

const DEPTH_LUA =
  "local r={} for i,k in ipairs(KEYS) do local t=redis.call('TYPE',k)['ok'] " +
  "if t=='zset' then r[i]=redis.call('ZCARD',k) elseif t=='list' then r[i]=redis.call('LLEN',k) " +
  'else r[i]=0 end end return r';

function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

function depthCommand(engine: 'valkey' | 'redis', def: QueueDef): string {
  const cli = engine === 'redis' ? 'redis-cli' : 'valkey-cli';
  const keys = depthKeys(def);
  return `${cli} --no-auth-warning -a "$(cat /run/secrets/${SECRET_TARGET})" EVAL "${DEPTH_LUA}" ${keys.length} ${keys.map(shQuote).join(' ')}`;
}

function parseRedisIntegers(raw: string): number[] {
  const out: number[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const m = /^(?:\d+\)\s*)?(?:\(integer\)\s*)?(-?\d+)$/.exec(t);
    if (m) out.push(Number(m[1]));
  }
  return out;
}

function parseDepthOutput(raw: string, convention: Convention): Omit<Sample, 'ts'> | null {
  const ints = parseRedisIntegers(raw);
  if (convention === 'list') {
    if (ints.length < 1) return null;
    return { wait: ints[0] ?? 0, active: 0, failed: 0, delayed: 0 };
  }
  if (ints.length < 4) return null;
  return { wait: ints[0] ?? 0, active: ints[1] ?? 0, failed: ints[2] ?? 0, delayed: ints[3] ?? 0 };
}

function desiredWorkers(def: QueueDef, wait: number): number {
  const raw = Math.ceil(Math.max(0, wait) / Math.max(1, def.scalePerJobs));
  const min = Math.max(0, def.minWorkers);
  const max = Math.max(min, def.maxWorkers);
  return Math.min(max, Math.max(min, raw));
}

function parseCacheRef(ref: string, defaultStack: string): { stack: string; cluster: string } {
  const i = ref.indexOf('/');
  if (i > 0) return { stack: ref.slice(0, i), cluster: ref.slice(i + 1) };
  return { stack: defaultStack, cluster: ref };
}

// ── Live plumbing ─────────────────────────────────────────────────────────────

function findCachePrimary(
  services: SwarmServiceInfo[],
  workerStack: string,
  cacheCluster: string,
): SwarmServiceInfo | undefined {
  const ref = parseCacheRef(cacheCluster, workerStack);
  return services.find(
    (s) =>
      s.labels[CACHE_ROLE_LABEL] === 'primary' &&
      s.labels[CACHE_CLUSTER_LABEL] === ref.cluster &&
      (s.labels[STACK_LABEL] ?? '') === ref.stack,
  );
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

async function sampleDepths(
  orgId: string,
  primary: SwarmServiceInfo,
  def: QueueDef,
): Promise<Sample | null> {
  const target = execTarget(orgId, primary);
  if (!target) return null;
  const engine = primary.labels[CACHE_ENGINE_LABEL] === 'redis' ? 'redis' : 'valkey';
  try {
    const res = await hub.dispatch<{ exitCode: number; output?: string }>(
      target.nodeId,
      'exec',
      {
        target: { containerId: target.containerId },
        cmd: ['sh', '-c', depthCommand(engine, def)],
        tty: false,
        stream: false,
      },
      { timeoutMs: EXEC_TIMEOUT_MS },
    );
    if (res.exitCode !== 0 || res.output == null) return null;
    const sample = parseDepthOutput(res.output, def.convention);
    return sample ? { ...sample, ts: new Date().toISOString() } : null;
  } catch {
    return null;
  }
}

// ── Reconcile ─────────────────────────────────────────────────────────────────

async function reconcileOrg(orgId: string): Promise<void> {
  const node = hub.managerNode(orgId);
  if (!node) return;

  const { services } = hub.liveInventory(orgId);
  const workers = services.filter((s) => Boolean(s.labels[QUEUES_LABEL]));
  if (workers.length === 0) return;

  const ctx = systemContext({ db: prisma, hub, auth: authRegistry.getAuth() }, orgId);

  for (const worker of workers) {
    const defs = parseQueuesLabel(worker.labels[QUEUES_LABEL]);
    if (defs.length === 0) continue;
    const workerStack = worker.labels[STACK_LABEL] ?? '';
    const prev = parseStatsLabel(worker.labels[QUEUES_STATS_LABEL]);
    const next: Record<string, Sample> = {};
    let sampled = false;
    let scaleTarget = 0;

    for (const def of defs) {
      const primary = findCachePrimary(services, workerStack, def.cacheCluster);
      const sample = primary ? await sampleDepths(orgId, primary, def) : null;
      if (!sample) {
        // Keep the last-known stamp so the dashboard doesn't blank out.
        const kept = prev[def.name];
        if (kept) next[def.name] = kept;
        continue;
      }
      sampled = true;
      next[def.name] = sample;
      scaleTarget = Math.max(scaleTarget, desiredWorkers(def, sample.wait));

      // Alerts — failure pile-up, and a backlog growing beyond max capacity.
      if (sample.failed >= FAILED_ALERT_THRESHOLD) {
        await fireEvent(ctx, {
          signal: 'queue-failed-jobs',
          severity: 'warning',
          resource: `${worker.name}/${def.name}`,
          message: `Queue ${def.name}: ${sample.failed} failed jobs on ${worker.name} — retry or inspect the DLQ`,
        }).catch(() => undefined);
      }
      const prevSample = prev[def.name];
      const capacity = def.scalePerJobs * def.maxWorkers;
      if (prevSample && sample.wait > prevSample.wait && sample.wait > capacity) {
        await fireEvent(ctx, {
          signal: 'queue-backlog',
          severity: 'warning',
          resource: `${worker.name}/${def.name}`,
          message: `Queue ${def.name}: backlog ${sample.wait} and growing — beyond ${def.maxWorkers} workers × ${def.scalePerJobs} jobs`,
        }).catch(() => undefined);
      }
    }

    // (1) Stamp last-known stats (only when a stamp would actually change).
    const encoded = JSON.stringify(next);
    if (Object.keys(next).length > 0 && encoded !== worker.labels[QUEUES_STATS_LABEL]) {
      await hub
        .dispatch(node, 'service.updateLabels', {
          service: worker.name,
          add: { [QUEUES_STATS_LABEL]: encoded },
          removeKeys: [],
        })
        .catch(() => undefined);
    }

    // (2) Scale the worker service between min/max (max across shared queues).
    // Only act on a live sample — never scale blind off stale numbers.
    if (sampled && worker.mode !== 'global') {
      const desired = worker.desiredReplicas ?? 0;
      if (desired !== scaleTarget) {
        await hub
          .dispatch(node, 'service.scale', { service: worker.name, replicas: scaleTarget })
          .catch(() => undefined);
      }
    }
  }
}

export function startQueueReconcile(): () => void {
  const timer = setInterval(() => {
    const orgIds = new Set(store.nodeOrg.values());
    for (const orgId of orgIds) void reconcileOrg(orgId).catch(() => undefined);
  }, TICK_MS);
  return () => clearInterval(timer);
}
