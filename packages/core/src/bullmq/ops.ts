/**
 * Queue-studio operations over a BullMQ keyspace — the pure half of the
 * `queueOp` agent command (`../protocol/queueOp.ts`).
 *
 * Why Lua through the cache's own CLI, not the `bullmq` package: a managed
 * cache is private-only (no published port, reachable only on its overlay by
 * swarm DNS), and the controller has no TCP path into it. The agent already
 * execs into the cache primary for INFO/depth probes, with the password read
 * from the mounted secret file inside the container. So each op is ONE
 * `EVAL` there:
 *   - reads are swarmy's own bounded read-only scripts (`./lua.ts`), and
 *   - writes are BullMQ's OWN mutation scripts, vendored verbatim
 *     (`./vendored.generated.ts`), called with the KEYS/ARGV its Queue/Job
 *     methods pass. A studio retry or promote therefore updates the markers,
 *     events stream, priority counter and paused meta exactly as a BullMQ
 *     client would. A hand-rolled `ZPOPMIN` + `LPUSH` skips all of that and
 *     strands jobs that blocked workers never wake for.
 * Every script runs atomically in the engine, so a concurrent worker can't
 * interleave with a half-applied op.
 */
import { z } from 'zod';
import { JOB_LUA, JOBS_LUA, OVERVIEW_LUA } from './lua';
import {
  CLEANJOBSINSET_LUA,
  DRAIN_LUA,
  MOVEJOBSTOWAIT_LUA,
  PAUSE_LUA,
  PROMOTE_LUA,
  REMOVEJOB_LUA,
  REPROCESSJOB_LUA,
} from './vendored.generated';

// ── Inputs ───────────────────────────────────────────────────────────────────

/** BullMQ key prefix (`bull` by default; `{bull}` hash-tag form allowed). */
export const BullPrefix = z
  .string()
  .regex(/^[A-Za-z0-9_.{}-]{1,64}$/, 'a BullMQ prefix: letters, digits, _ . - { }')
  .default('bull');
/** BullMQ forbids `:` in queue names; also no whitespace/control chars. */
export const BullQueueName = z.string().regex(/^[^:\s\p{Cc}]{1,200}$/u, 'a BullMQ queue name (no ":" or spaces)');
/** BullMQ job ids (numeric counter or custom ids — never containing `:`). */
export const BullJobId = z.string().regex(/^[^:\s\p{Cc}]{1,256}$/u, 'a BullMQ job id');

/** Job states as BullMQ keys them. */
export const BULL_STATES = [
  'wait',
  'paused',
  'active',
  'prioritized',
  'delayed',
  'completed',
  'failed',
  'waiting-children',
] as const;
export const BullState = z.enum(BULL_STATES);
export type BullState = z.infer<typeof BullState>;

/** States `clean` may target — never `active` (those jobs hold worker locks). */
export const BULL_CLEAN_STATES = ['wait', 'paused', 'prioritized', 'delayed', 'completed', 'failed'] as const;
export const BullCleanState = z.enum(BULL_CLEAN_STATES);
export type BullCleanState = z.infer<typeof BullCleanState>;

export const QUEUE_PAGE_MAX = 100;
export const QUEUE_DATA_MAX = 64 * 1024;
export const QUEUE_SUMMARY_DATA_MAX = 2_048;

const base = { prefix: BullPrefix };
const q = { ...base, queue: BullQueueName };

export const QueueOp = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('overview'),
    ...base,
    /** Count exactly these queues (skips the SCAN), else discover. */
    queues: z.array(BullQueueName).max(200).default([]),
    /** queue → last seen events-stream id; events after it are counted. */
    eventsSince: z.record(z.string().regex(/^\d+-\d+$/)).default({}),
    maxScanIterations: z.number().int().min(1).max(1000).default(200),
    maxQueues: z.number().int().min(1).max(200).default(100),
  }),
  z.object({
    kind: z.literal('jobs'),
    ...q,
    state: BullState,
    start: z.number().int().min(0).max(10_000_000).default(0),
    count: z.number().int().min(1).max(QUEUE_PAGE_MAX).default(25),
  }),
  z.object({ kind: z.literal('job'), ...q, id: BullJobId }),
  /** One failed/completed job back to wait (BullMQ `Job.retry`). */
  z.object({ kind: z.literal('retry'), ...q, id: BullJobId, from: z.enum(['failed', 'completed']).default('failed') }),
  /** A batch of failed/completed jobs back to wait (BullMQ `Queue.retryJobs`). */
  z.object({
    kind: z.literal('retryAll'),
    ...q,
    from: z.enum(['failed', 'completed']).default('failed'),
    count: z.number().int().min(1).max(10_000).default(1000),
    /** Only jobs finished at/before this (ms epoch). */
    timestamp: z.number().int().min(0),
  }),
  /** One delayed job to wait now (BullMQ `Job.promote`). */
  z.object({ kind: z.literal('promote'), ...q, id: BullJobId }),
  /** A batch of delayed jobs to wait (BullMQ `Queue.promoteJobs`). */
  z.object({ kind: z.literal('promoteAll'), ...q, count: z.number().int().min(1).max(10_000).default(1000) }),
  /** Remove one job + its children (BullMQ `Job.remove`); refused while locked. */
  z.object({ kind: z.literal('remove'), ...q, id: BullJobId }),
  /** Remove up to `limit` jobs in a state older than `timestamp` (BullMQ `Queue.clean`). */
  z.object({
    kind: z.literal('clean'),
    ...q,
    state: BullCleanState,
    timestamp: z.number().int().min(0),
    limit: z.number().int().min(1).max(10_000).default(1000),
  }),
  z.object({ kind: z.literal('pause'), ...q, paused: z.boolean() }),
  /** Delete waiting (+ optionally delayed) jobs (BullMQ `Queue.drain`). */
  z.object({ kind: z.literal('drain'), ...q, delayed: z.boolean().default(false) }),
]);
export type QueueOp = z.infer<typeof QueueOp>;
export type QueueOpInput = z.input<typeof QueueOp>;
export type QueueOpKind = QueueOp['kind'];

// ── EVAL plan ────────────────────────────────────────────────────────────────

export interface QueueEval {
  script: string;
  keys: string[];
  args: string[];
}

function keyBase(prefix: string, queue: string): string {
  return `${prefix}:${queue}:`;
}

/** The EVAL (script + KEYS + ARGV) for an op — mirrors BullMQ's own arg builders. */
export function queueOpEval(op: QueueOp): QueueEval {
  switch (op.kind) {
    case 'overview':
      return {
        script: OVERVIEW_LUA,
        keys: [],
        args: [
          op.prefix,
          String(op.maxScanIterations),
          JSON.stringify(op.queues),
          JSON.stringify(op.eventsSince),
          String(op.maxQueues),
        ],
      };
    case 'jobs':
      return {
        script: JOBS_LUA,
        keys: [],
        args: [op.prefix, op.queue, op.state, String(op.start), String(op.count), String(QUEUE_SUMMARY_DATA_MAX)],
      };
    case 'job':
      return { script: JOB_LUA, keys: [], args: [op.prefix, op.queue, op.id, String(QUEUE_DATA_MAX)] };
  }
  const b = keyBase(op.prefix, op.queue);
  switch (op.kind) {
    case 'retry':
      return {
        script: REPROCESSJOB_LUA.content,
        keys: [b + op.id, `${b}events`, b + op.from, `${b}wait`, `${b}meta`, `${b}paused`, `${b}active`, `${b}marker`],
        args: [op.id, 'LPUSH', op.from === 'failed' ? 'failedReason' : 'returnvalue', op.from, '0', '0'],
      };
    case 'retryAll':
      return {
        script: MOVEJOBSTOWAIT_LUA.content,
        keys: [b, `${b}events`, b + op.from, `${b}wait`, `${b}paused`, `${b}meta`, `${b}active`, `${b}marker`],
        args: [String(op.count), String(op.timestamp), op.from],
      };
    case 'promote':
      return {
        script: PROMOTE_LUA.content,
        keys: [
          `${b}delayed`,
          `${b}wait`,
          `${b}paused`,
          `${b}meta`,
          `${b}prioritized`,
          `${b}active`,
          `${b}pc`,
          `${b}events`,
          `${b}marker`,
        ],
        args: [b, op.id],
      };
    case 'promoteAll':
      return {
        script: MOVEJOBSTOWAIT_LUA.content,
        keys: [b, `${b}events`, `${b}delayed`, `${b}wait`, `${b}paused`, `${b}meta`, `${b}active`, `${b}marker`],
        args: [String(op.count), String(Number.MAX_VALUE), 'delayed'],
      };
    case 'remove':
      return { script: REMOVEJOB_LUA.content, keys: [b + op.id, `${b}repeat`], args: [op.id, '1', b] };
    case 'clean':
      return {
        script: CLEANJOBSINSET_LUA.content,
        keys: [b + op.state, `${b}events`, `${b}repeat`],
        args: [b, String(op.timestamp), String(op.limit), op.state],
      };
    case 'pause': {
      const [src, dst] = op.paused ? ['wait', 'paused'] : ['paused', 'wait'];
      return {
        script: PAUSE_LUA.content,
        keys: [b + src, b + dst, `${b}meta`, `${b}prioritized`, `${b}events`, `${b}delayed`, `${b}marker`],
        args: [op.paused ? 'paused' : 'resumed'],
      };
    }
    case 'drain':
      return {
        script: DRAIN_LUA.content,
        keys: [`${b}wait`, `${b}paused`, `${b}delayed`, `${b}prioritized`, `${b}repeat`],
        args: [b, op.delayed ? '1' : '0'],
      };
  }
}

/**
 * The exec argv that runs an EVAL inside a cache member. The password is read
 * from the mounted secret file into `REDISCLI_AUTH` (valkey-cli honours it
 * too), so it never appears in an argv or crosses the wire. Script, keys and
 * args ride as positional parameters (`"$@"`) and are never shell-interpolated.
 * `--json` makes every reply one JSON document.
 */
export function queueEvalArgv(engine: 'valkey' | 'redis', ev: QueueEval, secretTarget = 'cache-password'): string[] {
  const cli = engine === 'redis' ? 'redis-cli' : 'valkey-cli';
  return [
    'sh',
    '-c',
    `REDISCLI_AUTH="$(cat /run/secrets/${secretTarget})" exec ${cli} --json "$@"`,
    'sh',
    'EVAL',
    ev.script,
    String(ev.keys.length),
    ...ev.keys,
    ...ev.args,
  ];
}

// ── Replies ──────────────────────────────────────────────────────────────────

const Counts = z.object({
  wait: z.number(),
  paused: z.number(),
  active: z.number(),
  prioritized: z.number(),
  delayed: z.number(),
  completed: z.number(),
  failed: z.number(),
  waitingChildren: z.number(),
});
export type BullCounts = z.infer<typeof Counts>;

/** cjson encodes an empty Lua table as `{}` — read it as an empty array. */
const luaArray = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess((v) => (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0 ? [] : v), z.array(item));

export const BullQueueSample = z.object({
  name: z.string(),
  counts: Counts,
  isPaused: z.boolean(),
  jobsTotal: z.number(),
  metricsCompleted: z.number().nullable(),
  metricsFailed: z.number().nullable(),
  events: z.object({
    completed: z.number(),
    failed: z.number(),
    lastId: z.string().nullable(),
    saturated: z.boolean(),
  }),
});
export type BullQueueSample = z.infer<typeof BullQueueSample>;

export const QueueOverviewReply = z.object({ queues: luaArray(BullQueueSample), truncated: z.boolean() });
export type QueueOverviewReply = z.infer<typeof QueueOverviewReply>;

const nstr = z.string().nullable();
export const BullJobRow = z.object({
  id: z.string(),
  missing: z.boolean().optional(),
  name: nstr.optional(),
  data: nstr.optional(),
  dataTruncated: z.boolean().optional(),
  opts: nstr.optional(),
  progress: nstr.optional(),
  atm: nstr.optional(),
  attemptsMade: nstr.optional(),
  ats: nstr.optional(),
  timestamp: nstr.optional(),
  processedOn: nstr.optional(),
  finishedOn: nstr.optional(),
  failedReason: nstr.optional(),
  delay: nstr.optional(),
  priority: nstr.optional(),
  stacktrace: nstr.optional(),
  stacktraceTruncated: z.boolean().optional(),
  returnvalue: nstr.optional(),
  returnvalueTruncated: z.boolean().optional(),
  processedBy: nstr.optional(),
  parentKey: nstr.optional(),
  runAt: z.number().optional(),
});
export type BullJobRow = z.infer<typeof BullJobRow>;

export const QueueJobsReply = z.object({
  state: BullState,
  total: z.number(),
  start: z.number(),
  jobs: luaArray(BullJobRow),
});
export type QueueJobsReply = z.infer<typeof QueueJobsReply>;

export const QueueJobReply = z.union([
  z.object({ found: z.literal(false) }),
  z.object({
    found: z.literal(true),
    state: z.union([BullState, z.literal('unknown')]),
    job: BullJobRow,
    logs: luaArray(z.string()),
    logCount: z.number(),
  }),
]);
export type QueueJobReply = z.infer<typeof QueueJobReply>;

/** Mutations: BullMQ's own return codes, mapped to a plain outcome. */
export const QueueMutationReply = z.object({
  ok: z.boolean(),
  /** BullMQ's raw integer code (or the removed-id count for clean). */
  code: z.number(),
  message: z.string(),
  /** retryAll/promoteAll: more jobs remain for another batch. */
  more: z.boolean().optional(),
  /** clean: ids removed. */
  removedIds: z.array(z.string()).optional(),
});
export type QueueMutationReply = z.infer<typeof QueueMutationReply>;

export type QueueOpReply = QueueOverviewReply | QueueJobsReply | QueueJobReply | QueueMutationReply;

export class QueueOpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueOpError';
  }
}

/** `--json` output → one JSON value; engine error lines become QueueOpError. */
export function parseCliJson(stdout: string): unknown {
  const t = stdout.trim();
  if (!t) throw new QueueOpError('empty reply from the cache');
  if (/^(error:|\(error\)|ERR |NOAUTH|WRONGPASS|NOSCRIPT|BUSY|OOM)/.test(t)) {
    throw new QueueOpError(t.replace(/^error:\s*/, '').replace(/^"|"$/g, '').slice(0, 300));
  }
  try {
    return JSON.parse(t);
  } catch {
    throw new QueueOpError(`unreadable reply from the cache: ${t.slice(0, 200)}`);
  }
}

function mutation(ok: boolean, code: number, message: string, extra: Partial<QueueMutationReply> = {}): QueueMutationReply {
  return { ok, code, message, ...extra };
}

/** Parse the CLI reply for `op` into its typed result. */
export function parseQueueOpReply(op: QueueOp, stdout: string): QueueOpReply {
  const v = parseCliJson(stdout);
  const doc = (x: unknown): unknown => (typeof x === 'string' ? JSON.parse(x) : x);
  switch (op.kind) {
    case 'overview':
      return QueueOverviewReply.parse(doc(v));
    case 'jobs':
      return QueueJobsReply.parse(doc(v));
    case 'job':
      return QueueJobReply.parse(doc(v));
    case 'clean': {
      const ids = Array.isArray(v) ? v.map(String) : [];
      return mutation(true, ids.length, `removed ${ids.length} ${op.state} job${ids.length === 1 ? '' : 's'}`, {
        removedIds: ids,
      });
    }
  }
  const code = typeof v === 'number' ? v : Number(v);
  switch (op.kind) {
    case 'retry':
      return code === 1
        ? mutation(true, code, `job ${op.id} moved back to waiting`)
        : mutation(false, code, code === -1 ? `job ${op.id} does not exist` : `job ${op.id} is not ${op.from}`);
    case 'retryAll':
    case 'promoteAll':
      return mutation(true, code, code === 1 ? 'batch moved — more remain' : 'all moved', { more: code === 1 });
    case 'promote':
      return code === 0
        ? mutation(true, code, `job ${op.id} promoted to waiting`)
        : mutation(false, code, `job ${op.id} is not delayed`);
    case 'remove':
      if (code === 1) return mutation(true, code, `job ${op.id} removed`);
      if (code === 0) return mutation(false, code, `job ${op.id} is locked by a worker (active) — it can't be removed now`);
      if (code === -8) return mutation(false, code, `job ${op.id} belongs to a job scheduler — remove the scheduler instead`);
      return mutation(false, code, `job ${op.id} could not be removed (code ${code})`);
    case 'pause':
      return mutation(true, Number.isFinite(code) ? code : 0, op.paused ? `${op.queue} paused` : `${op.queue} resumed`);
    case 'drain':
      return mutation(true, Number.isFinite(code) ? code : 0, `${op.queue} drained`);
  }
}

/** Is `kind` a write (anything but the three reads)? */
export function isQueueWrite(kind: QueueOpKind): boolean {
  return kind !== 'overview' && kind !== 'jobs' && kind !== 'job';
}

/** Backlog the autoscaler reads: runnable jobs not yet picked up (0 while paused). */
export function queueBacklog(s: Pick<BullQueueSample, 'counts' | 'isPaused'>): number {
  if (s.isPaused) return 0;
  return s.counts.wait + s.counts.prioritized;
}
