import {
  buildInventory,
  QUEUE_CONVENTIONS,
  STACK_LABEL,
  type AttachQueueInput,
  type InvService,
  type QueueBatchInput,
  type QueueConvention,
  type QueueDef,
  type QueueDepthSample,
  type QueueDlqItemView,
  type QueueDlqListInput,
  type QueueDrainResult,
  type QueueRefInput,
  type QueueRequeueResult,
  type QueueRetryResult,
  type QueueView,
  type QueuesOverview,
  type UpdateQueueInput,
} from '@swarmy/core';
import type { OrgContext } from '../context';
import { commandRejected, mapDispatchError, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { resolveManagerNode } from './dispatch.service';
import { resolveExecTarget } from './live-resolve';

/**
 * Queues (slice B1) — queues over managed cache clusters, all Docker-truth.
 *
 * Queue definitions live in ONE JSON label on the WORKER service
 * (`swarmy.queues`): `[{name, cacheCluster, convention, listKey?, scalePerJobs,
 * minWorkers, maxWorkers, retries, dlq}]`. Depth stats are read live by exec'ing
 * `redis-cli`/`valkey-cli` on the backing cache cluster's PRIMARY container (the
 * password never rides the wire — the container reads it from its mounted
 * secret file), and the queue-reconcile worker stamps the last-known sample into
 * a `swarmy.queues.stats` label so the list renders without an exec fan-out.
 *
 * Key conventions:
 *   bullmq → `bull:<q>:wait` (list), `bull:<q>:active` (list),
 *            `bull:<q>:failed` + `bull:<q>:delayed` (zsets)
 *   list   → one raw list at `listKey` (defaults to the queue name)
 * DLQ (both conventions) is the swarmy convention `<q>:dead` raw list —
 * consumers RPUSH exhausted jobs there; requeue moves entries back to wait.
 *
 * The reconcile worker mirrors the pure helpers below (a worker cannot
 * subpath-import an internal @swarmy/trpc module — same constraint the
 * cache/manageddb reconcile workers document). This file holds the unit-tested
 * canonical copies.
 */

// ── Label scheme (Docker-truth; kept in sync with queue-reconcile.ts) ─────────
export const QUEUES_LABEL = 'swarmy.queues';
export const QUEUES_STATS_LABEL = 'swarmy.queues.stats';
// Cache-cluster labels owned by A3 (read-only here, to find the primary).
const CACHE_CLUSTER_LABEL = 'swarmy.cache.cluster';
const CACHE_ROLE_LABEL = 'swarmy.cache.role';
const CACHE_ENGINE_LABEL = 'swarmy.cache.engine';
const CACHE_SECRET_TARGET = 'cache-password';

const EXEC_TIMEOUT_MS = 30_000;
/** DLQ payload tail returned to the browser (per entry). */
const DLQ_PAYLOAD_MAX = 2_048;

type CacheEngineKind = 'valkey' | 'redis';

// ── Pure: label codecs ────────────────────────────────────────────────────────

/** Coerce one raw label entry into a QueueDef; null when malformed. */
function coerceDef(v: unknown): QueueDef | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.name !== 'string' || !o.name) return null;
  if (typeof o.cacheCluster !== 'string' || !o.cacheCluster) return null;
  const convention: QueueConvention = (QUEUE_CONVENTIONS as readonly string[]).includes(
    String(o.convention),
  )
    ? (o.convention as QueueConvention)
    : 'bullmq';
  const num = (x: unknown, fallback: number, min: number): number => {
    const n = typeof x === 'number' ? Math.floor(x) : Number.parseInt(String(x), 10);
    return Number.isFinite(n) && n >= min ? n : fallback;
  };
  const minWorkers = num(o.minWorkers, 1, 0);
  return {
    name: o.name,
    cacheCluster: o.cacheCluster,
    convention,
    ...(typeof o.listKey === 'string' && o.listKey ? { listKey: o.listKey } : {}),
    scalePerJobs: num(o.scalePerJobs, 100, 1),
    minWorkers,
    maxWorkers: Math.max(minWorkers, num(o.maxWorkers, 5, 1)),
    retries: num(o.retries, 3, 0),
    dlq: o.dlq !== false,
  };
}

/** Parse the `swarmy.queues` label; malformed JSON/entries degrade to []. */
export function parseQueuesLabel(raw: string | undefined | null): QueueDef[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.map(coerceDef).filter((d): d is QueueDef => d !== null);
  } catch {
    return [];
  }
}

/** Encode queue defs for the `swarmy.queues` label (stable field order). */
export function encodeQueuesLabel(defs: QueueDef[]): string {
  return JSON.stringify(
    defs.map((d) => ({
      name: d.name,
      cacheCluster: d.cacheCluster,
      convention: d.convention,
      ...(d.listKey ? { listKey: d.listKey } : {}),
      scalePerJobs: d.scalePerJobs,
      minWorkers: d.minWorkers,
      maxWorkers: d.maxWorkers,
      retries: d.retries,
      dlq: d.dlq,
    })),
  );
}

/** Parse the `swarmy.queues.stats` label → { queueName: sample }. */
export function parseQueueStatsLabel(
  raw: string | undefined | null,
): Record<string, QueueDepthSample> {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as Record<string, Partial<QueueDepthSample>>;
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return {};
    const out: Record<string, QueueDepthSample> = {};
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

/** Encode the stats map for the `swarmy.queues.stats` label. */
export function encodeQueueStatsLabel(stats: Record<string, QueueDepthSample>): string {
  return JSON.stringify(stats);
}

/** `<stack>/<cluster>` or bare `<cluster>` (defaults to the worker's stack). */
export function parseCacheClusterRef(
  ref: string,
  defaultStack: string,
): { stack: string; cluster: string } {
  const i = ref.indexOf('/');
  if (i > 0) return { stack: ref.slice(0, i), cluster: ref.slice(i + 1) };
  return { stack: defaultStack, cluster: ref };
}

/** The cache primary's Docker service name (A3 naming: `<stack>_<cluster>-cache`). */
export function cachePrimaryServiceName(stack: string, cluster: string): string {
  return `${stack}_${cluster}-cache`;
}

// ── Pure: redis key builders ──────────────────────────────────────────────────

export interface QueueKeys {
  /** Waiting jobs (list). */
  wait: string;
  /** In-flight jobs (list) — null for raw-list queues. */
  active: string | null;
  /** Failed jobs (zset) — null for raw-list queues. */
  failed: string | null;
  /** Delayed jobs (zset) — null for raw-list queues. */
  delayed: string | null;
  /** Dead-letter list (`<q>:dead`, swarmy convention for both conventions). */
  dead: string;
}

/** The redis keys a queue's depth/actions operate on. */
export function queueKeys(def: Pick<QueueDef, 'name' | 'convention' | 'listKey'>): QueueKeys {
  if (def.convention === 'list') {
    const wait = def.listKey?.trim() || def.name;
    return { wait, active: null, failed: null, delayed: null, dead: `${wait}:dead` };
  }
  return {
    wait: `bull:${def.name}:wait`,
    active: `bull:${def.name}:active`,
    failed: `bull:${def.name}:failed`,
    delayed: `bull:${def.name}:delayed`,
    dead: `${def.name}:dead`,
  };
}

// ── Pure: scale decision ──────────────────────────────────────────────────────

/** clamp(ceil(wait / scalePerJobs), minWorkers, maxWorkers). */
export function desiredWorkers(
  def: Pick<QueueDef, 'scalePerJobs' | 'minWorkers' | 'maxWorkers'>,
  wait: number,
): number {
  const raw = Math.ceil(Math.max(0, wait) / Math.max(1, def.scalePerJobs));
  const min = Math.max(0, def.minWorkers);
  const max = Math.max(min, def.maxWorkers);
  return Math.min(max, Math.max(min, raw));
}

// ── Pure: redis-cli command builders + output parsers ─────────────────────────

/** Single-quote a validated redis key for the shell command line. */
export function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** CLI prefix reading the cluster password from the mounted secret file. */
export function redisCliPrefix(engine: CacheEngineKind): string {
  const cli = engine === 'redis' ? 'redis-cli' : 'valkey-cli';
  return `${cli} --no-auth-warning -a "$(cat /run/secrets/${CACHE_SECRET_TARGET})"`;
}

/** Depth probe: LLEN lists / ZCARD zsets, 0 for missing keys — one round trip. */
const DEPTH_LUA =
  "local r={} for i,k in ipairs(KEYS) do local t=redis.call('TYPE',k)['ok'] " +
  "if t=='zset' then r[i]=redis.call('ZCARD',k) elseif t=='list' then r[i]=redis.call('LLEN',k) " +
  'else r[i]=0 end end return r';

/** Full shell command sampling a queue's depths (wait[, active, failed, delayed]). */
export function depthCommand(
  engine: CacheEngineKind,
  def: Pick<QueueDef, 'name' | 'convention' | 'listKey'>,
): string {
  const k = queueKeys(def);
  const keys =
    def.convention === 'list' ? [k.wait] : [k.wait, k.active ?? '', k.failed ?? '', k.delayed ?? ''];
  return `${redisCliPrefix(engine)} EVAL "${DEPTH_LUA}" ${keys.length} ${keys
    .map(shQuote)
    .join(' ')}`;
}

/**
 * Bounded retry-failed batch (BullMQ): pop up to `limit` job ids off the failed
 * zset and push them back onto wait. Returns {moved, remaining}.
 */
const RETRY_LUA =
  'local moved=0 local n=tonumber(ARGV[1]) for i=1,n do ' +
  "local m=redis.call('ZPOPMIN',KEYS[1]) if #m==0 then break end " +
  "redis.call('LPUSH',KEYS[2],m[1]) moved=moved+1 end " +
  "return {moved,redis.call('ZCARD',KEYS[1])}";

export function retryFailedCommand(
  engine: CacheEngineKind,
  def: Pick<QueueDef, 'name' | 'convention' | 'listKey'>,
  limit: number,
): string {
  const k = queueKeys(def);
  if (!k.failed) throw new Error('retryFailed requires the bullmq convention');
  return `${redisCliPrefix(engine)} EVAL "${RETRY_LUA}" 2 ${shQuote(k.failed)} ${shQuote(k.wait)} ${Math.floor(limit)}`;
}

/** Drain: DEL wait (+ delayed for bullmq); returns the number of jobs removed. */
const DRAIN_BULL_LUA =
  "local w=redis.call('LLEN',KEYS[1]) local d=redis.call('ZCARD',KEYS[2]) " +
  "redis.call('DEL',KEYS[1],KEYS[2]) return w+d";
const DRAIN_LIST_LUA = "local w=redis.call('LLEN',KEYS[1]) redis.call('DEL',KEYS[1]) return w";

export function drainCommand(
  engine: CacheEngineKind,
  def: Pick<QueueDef, 'name' | 'convention' | 'listKey'>,
): string {
  const k = queueKeys(def);
  if (def.convention === 'list') {
    return `${redisCliPrefix(engine)} EVAL "${DRAIN_LIST_LUA}" 1 ${shQuote(k.wait)}`;
  }
  return `${redisCliPrefix(engine)} EVAL "${DRAIN_BULL_LUA}" 2 ${shQuote(k.wait)} ${shQuote(k.delayed ?? k.wait)}`;
}

/** Browse the DLQ tail (newest entries are RPUSHed, so the head is oldest). */
export function dlqListCommand(
  engine: CacheEngineKind,
  def: Pick<QueueDef, 'name' | 'convention' | 'listKey'>,
  limit: number,
): string {
  const k = queueKeys(def);
  return `${redisCliPrefix(engine)} LRANGE ${shQuote(k.dead)} 0 ${Math.floor(limit) - 1}`;
}

/** Bounded DLQ requeue: RPOPLPUSH dead → wait. Returns {moved, remaining}. */
const REQUEUE_LUA =
  'local moved=0 local n=tonumber(ARGV[1]) for i=1,n do ' +
  "local v=redis.call('RPOPLPUSH',KEYS[1],KEYS[2]) if not v then break end moved=moved+1 end " +
  "return {moved,redis.call('LLEN',KEYS[1])}";

export function dlqRequeueCommand(
  engine: CacheEngineKind,
  def: Pick<QueueDef, 'name' | 'convention' | 'listKey'>,
  limit: number,
): string {
  const k = queueKeys(def);
  return `${redisCliPrefix(engine)} EVAL "${REQUEUE_LUA}" 2 ${shQuote(k.dead)} ${shQuote(k.wait)} ${Math.floor(limit)}`;
}

/**
 * Integers out of redis-cli output — tolerant of raw mode (`5`), tty decoration
 * (`1) (integer) 5`) and CRLF. Non-integer lines (errors, payloads) are skipped.
 */
export function parseRedisIntegers(raw: string): number[] {
  const out: number[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const m = /^(?:\d+\)\s*)?(?:\(integer\)\s*)?(-?\d+)$/.exec(t);
    if (m) out.push(Number(m[1]));
  }
  return out;
}

/** Depth EVAL output → sample (list convention pads active/failed/delayed = 0). */
export function parseDepthOutput(
  raw: string,
  convention: QueueConvention,
): Omit<QueueDepthSample, 'ts'> | null {
  const ints = parseRedisIntegers(raw);
  if (convention === 'list') {
    if (ints.length < 1) return null;
    return { wait: ints[0] ?? 0, active: 0, failed: 0, delayed: 0 };
  }
  if (ints.length < 4) return null;
  return { wait: ints[0] ?? 0, active: ints[1] ?? 0, failed: ints[2] ?? 0, delayed: ints[3] ?? 0 };
}

/** String elements out of redis-cli LRANGE output (raw or tty-decorated). */
export function parseRedisStrings(raw: string): string[] {
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (/^\(empty (array|list or set)\)$/.test(t)) continue;
    const m = /^\d+\)\s*"(.*)"$/.exec(t);
    if (m) out.push(m[1]!.replaceAll('\\"', '"').replaceAll('\\\\', '\\'));
    else out.push(line);
  }
  return out;
}

// ── Live lookups (hub inventory — never the DB) ───────────────────────────────

function liveOrgServices(ctx: OrgContext): InvService[] {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  return buildInventory(services, containers).services;
}

function findWorker(services: InvService[], idOrName: string): InvService | undefined {
  return services.find((s) => s.id === idOrName) ?? services.find((s) => s.name === idOrName);
}

function requireWorker(services: InvService[], idOrName: string): InvService {
  const svc = findWorker(services, idOrName);
  if (!svc) throw notFound('service', idOrName);
  return svc;
}

function requireDef(worker: InvService, queue: string): QueueDef {
  const def = parseQueuesLabel(worker.labels[QUEUES_LABEL]).find((d) => d.name === queue);
  if (!def) throw notFound('queue', `${worker.name}/${queue}`);
  return def;
}

/** The backing cache cluster's primary member, from A3's `swarmy.cache.*` labels. */
function findCachePrimary(
  services: InvService[],
  workerStack: string,
  cacheCluster: string,
): InvService | undefined {
  const ref = parseCacheClusterRef(cacheCluster, workerStack);
  return services.find(
    (s) =>
      s.labels[CACHE_ROLE_LABEL] === 'primary' &&
      s.labels[CACHE_CLUSTER_LABEL] === ref.cluster &&
      (s.labels[STACK_LABEL] ?? s.stack) === ref.stack,
  );
}

function engineOf(primary: InvService | undefined): CacheEngineKind {
  return primary?.labels[CACHE_ENGINE_LABEL] === 'redis' ? 'redis' : 'valkey';
}

/** Run a redis-cli command inside the cache primary's running container. */
async function execOnPrimary(
  ctx: OrgContext,
  primary: InvService,
  script: string,
): Promise<string> {
  const target = resolveExecTarget(ctx, primary.name);
  if (!target) {
    throw commandRejected(`cache primary "${primary.name}" has no running container`);
  }
  let res: { exitCode: number; output?: string };
  try {
    res = await ctx.hub.dispatch<{ exitCode: number; output?: string }>(
      target.nodeId,
      'exec',
      {
        target: { containerId: target.containerId },
        cmd: ['sh', '-c', script],
        tty: false,
        stream: false,
      },
      { timeoutMs: EXEC_TIMEOUT_MS },
    );
  } catch (e) {
    throw mapDispatchError(e);
  }
  if (res.exitCode !== 0) {
    throw commandRejected(`redis-cli exited ${res.exitCode}: ${(res.output ?? '').slice(0, 200)}`);
  }
  return res.output ?? '';
}

/** Resolve worker + def + backing primary in one go (mutations/action paths). */
function resolveQueue(
  ctx: OrgContext,
  ref: QueueRefInput,
): { services: InvService[]; worker: InvService; def: QueueDef; primary: InvService } {
  const services = liveOrgServices(ctx);
  const worker = requireWorker(services, ref.workerService);
  const def = requireDef(worker, ref.queue);
  const primary = findCachePrimary(services, worker.stack, def.cacheCluster);
  if (!primary) throw notFound('cache cluster', def.cacheCluster);
  return { services, worker, def, primary };
}

// ── View projection ───────────────────────────────────────────────────────────

function toView(services: InvService[], worker: InvService, def: QueueDef): QueueView {
  const ref = parseCacheClusterRef(def.cacheCluster, worker.stack);
  const primary = findCachePrimary(services, worker.stack, def.cacheCluster);
  const stats = parseQueueStatsLabel(worker.labels[QUEUES_STATS_LABEL]);
  return {
    ...def,
    workerService: worker.name,
    stack: worker.stack,
    cacheStack: ref.stack,
    cacheName: ref.cluster,
    cacheOnline: Boolean(primary && primary.replicas.running > 0),
    workers: { desired: worker.replicas.desired, running: worker.replicas.running },
    stats: stats[def.name] ?? null,
  };
}

/** Every queue in the org (optionally one stack's) — inventory scan for `swarmy.queues` labels. */
export function listQueues(ctx: OrgContext, stack?: string): QueueView[] {
  const services = liveOrgServices(ctx);
  const out: QueueView[] = [];
  for (const svc of services) {
    if (stack && svc.stack !== stack) continue;
    for (const def of parseQueuesLabel(svc.labels[QUEUES_LABEL])) {
      out.push(toView(services, svc, def));
    }
  }
  return out.sort((a, b) =>
    `${a.workerService}/${a.name}`.localeCompare(`${b.workerService}/${b.name}`),
  );
}

/** Aggregates for the Queues page hero (optionally scoped to one stack). */
export function queuesOverview(ctx: OrgContext, stack?: string): QueuesOverview {
  const queues = listQueues(ctx, stack);
  const workersByService = new Map<string, number>();
  let totalWait = 0;
  let totalActive = 0;
  let totalFailed = 0;
  for (const q of queues) {
    workersByService.set(q.workerService, q.workers.running);
    totalWait += q.stats?.wait ?? 0;
    totalActive += q.stats?.active ?? 0;
    totalFailed += q.stats?.failed ?? 0;
  }
  return {
    queues: queues.length,
    workersRunning: [...workersByService.values()].reduce((n, v) => n + v, 0),
    totalWait,
    totalActive,
    totalFailed,
  };
}

// ── Mutations (label writes via service.updateLabels) ─────────────────────────

async function stampLabels(
  ctx: OrgContext,
  workerName: string,
  add: Record<string, string>,
  removeKeys: string[] = [],
): Promise<void> {
  const node = await resolveManagerNode(ctx);
  try {
    await ctx.hub.dispatch(node.id, 'service.updateLabels', {
      service: workerName,
      add,
      removeKeys,
    });
  } catch (e) {
    throw mapDispatchError(e);
  }
}

function normalizeRules(input: AttachQueueInput): AttachQueueInput {
  if (input.minWorkers > input.maxWorkers) {
    throw commandRejected('minWorkers must be ≤ maxWorkers');
  }
  return input;
}

function toDef(input: AttachQueueInput): QueueDef {
  return {
    name: input.name,
    cacheCluster: input.cacheCluster,
    convention: input.convention,
    ...(input.convention === 'list' ? { listKey: input.listKey?.trim() || input.name } : {}),
    scalePerJobs: input.scalePerJobs,
    minWorkers: input.minWorkers,
    maxWorkers: input.maxWorkers,
    retries: input.retries,
    dlq: input.dlq,
  };
}

/** Attach a queue to a worker service (appends to the `swarmy.queues` label). */
export async function attachQueue(ctx: OrgContext, input: AttachQueueInput): Promise<QueueView> {
  normalizeRules(input);
  const services = liveOrgServices(ctx);
  const worker = requireWorker(services, input.workerService);
  const defs = parseQueuesLabel(worker.labels[QUEUES_LABEL]);
  if (defs.some((d) => d.name === input.name)) {
    throw commandRejected(`queue "${input.name}" already exists on ${worker.name}`);
  }
  if (!findCachePrimary(services, worker.stack, input.cacheCluster)) {
    throw notFound('cache cluster', input.cacheCluster);
  }
  const def = toDef(input);
  const next = [...defs, def];
  await stampLabels(ctx, worker.name, { [QUEUES_LABEL]: encodeQueuesLabel(next) });
  await writeAudit(ctx, {
    action: 'queues.attach',
    targetType: 'queue',
    targetId: `${worker.name}/${def.name}`,
    metadata: { ...def, workerService: worker.name },
  });
  return toView(services, worker, def);
}

/** Update a queue def in place (matched by name on the worker service). */
export async function updateQueue(ctx: OrgContext, input: UpdateQueueInput): Promise<QueueView> {
  normalizeRules(input);
  const services = liveOrgServices(ctx);
  const worker = requireWorker(services, input.workerService);
  const defs = parseQueuesLabel(worker.labels[QUEUES_LABEL]);
  if (!defs.some((d) => d.name === input.name)) throw notFound('queue', input.name);
  if (!findCachePrimary(services, worker.stack, input.cacheCluster)) {
    throw notFound('cache cluster', input.cacheCluster);
  }
  const def = toDef(input);
  const next = defs.map((d) => (d.name === input.name ? def : d));
  await stampLabels(ctx, worker.name, { [QUEUES_LABEL]: encodeQueuesLabel(next) });
  await writeAudit(ctx, {
    action: 'queues.update',
    targetType: 'queue',
    targetId: `${worker.name}/${def.name}`,
    metadata: { ...def, workerService: worker.name },
  });
  return toView(services, worker, def);
}

/** Remove a queue def (clears both labels when it was the last one). */
export async function removeQueue(
  ctx: OrgContext,
  input: QueueRefInput,
): Promise<{ queue: string; removed: true }> {
  const services = liveOrgServices(ctx);
  const worker = requireWorker(services, input.workerService);
  const defs = parseQueuesLabel(worker.labels[QUEUES_LABEL]);
  const next = defs.filter((d) => d.name !== input.queue);
  if (next.length === defs.length) throw notFound('queue', input.queue);
  if (next.length === 0) {
    await stampLabels(ctx, worker.name, {}, [QUEUES_LABEL, QUEUES_STATS_LABEL]);
  } else {
    const stats = parseQueueStatsLabel(worker.labels[QUEUES_STATS_LABEL]);
    delete stats[input.queue];
    await stampLabels(ctx, worker.name, {
      [QUEUES_LABEL]: encodeQueuesLabel(next),
      [QUEUES_STATS_LABEL]: encodeQueueStatsLabel(stats),
    });
  }
  await writeAudit(ctx, {
    action: 'queues.remove',
    targetType: 'queue',
    targetId: `${worker.name}/${input.queue}`,
    metadata: { workerService: worker.name },
  });
  return { queue: input.queue, removed: true };
}

// ── Live stats + actions (exec redis-cli on the cache primary) ────────────────

/** Live depth sample (falls back to the reconcile worker's label stamp). */
export async function queueStats(
  ctx: OrgContext,
  ref: QueueRefInput,
): Promise<QueueDepthSample | null> {
  const services = liveOrgServices(ctx);
  const worker = requireWorker(services, ref.workerService);
  const def = requireDef(worker, ref.queue);
  const fallback = parseQueueStatsLabel(worker.labels[QUEUES_STATS_LABEL])[def.name] ?? null;
  const primary = findCachePrimary(services, worker.stack, def.cacheCluster);
  if (!primary) return fallback;
  try {
    const raw = await execOnPrimary(ctx, primary, depthCommand(engineOf(primary), def));
    const sample = parseDepthOutput(raw, def.convention);
    return sample ? { ...sample, ts: new Date().toISOString() } : fallback;
  } catch {
    return fallback;
  }
}

/** Bounded retry batch: BullMQ failed zset → wait list (audited). */
export async function retryFailed(
  ctx: OrgContext,
  input: QueueBatchInput,
): Promise<QueueRetryResult> {
  const { worker, def, primary } = resolveQueue(ctx, input);
  if (def.convention !== 'bullmq') {
    throw commandRejected('retry-failed applies to BullMQ queues only');
  }
  const raw = await execOnPrimary(
    ctx,
    primary,
    retryFailedCommand(engineOf(primary), def, input.limit),
  );
  const [moved = 0, remaining = 0] = parseRedisIntegers(raw);
  await writeAudit(ctx, {
    action: 'queues.retryFailed',
    targetType: 'queue',
    targetId: `${worker.name}/${def.name}`,
    metadata: { moved, remaining, limit: input.limit },
  });
  return { queue: def.name, moved, remaining };
}

/** Drain the queue: delete waiting (+ delayed) jobs (audited). */
export async function drainQueue(ctx: OrgContext, input: QueueRefInput): Promise<QueueDrainResult> {
  const { worker, def, primary } = resolveQueue(ctx, input);
  const raw = await execOnPrimary(ctx, primary, drainCommand(engineOf(primary), def));
  const [removed = 0] = parseRedisIntegers(raw);
  await writeAudit(ctx, {
    action: 'queues.drain',
    targetType: 'queue',
    targetId: `${worker.name}/${def.name}`,
    metadata: { removed },
  });
  return { queue: def.name, removed };
}

/** Browse the dead-letter list (`<q>:dead`), payloads truncated. */
export async function dlqList(
  ctx: OrgContext,
  input: QueueDlqListInput,
): Promise<QueueDlqItemView[]> {
  const { def, primary } = resolveQueue(ctx, input);
  const raw = await execOnPrimary(
    ctx,
    primary,
    dlqListCommand(engineOf(primary), def, input.limit),
  );
  return parseRedisStrings(raw)
    .slice(0, input.limit)
    .map((payload, index) => ({ index, payload: payload.slice(0, DLQ_PAYLOAD_MAX) }));
}

/** Bounded DLQ requeue batch: dead list → wait (audited). */
export async function dlqRequeue(
  ctx: OrgContext,
  input: QueueBatchInput,
): Promise<QueueRequeueResult> {
  const { worker, def, primary } = resolveQueue(ctx, input);
  const raw = await execOnPrimary(
    ctx,
    primary,
    dlqRequeueCommand(engineOf(primary), def, input.limit),
  );
  const [moved = 0, remaining = 0] = parseRedisIntegers(raw);
  await writeAudit(ctx, {
    action: 'queues.dlqRequeue',
    targetType: 'queue',
    targetId: `${worker.name}/${def.name}`,
    metadata: { moved, remaining, limit: input.limit },
  });
  return { queue: def.name, moved, remaining };
}
