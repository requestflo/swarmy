/**
 * Queue studio — the pure half (tested): input schemas, the rate sampler's
 * delta math, and the ClickHouse DDL + read builder for the sampled series.
 *
 * Rates live in the observability store (ClickHouse, next to the org's
 * telemetry) as `swarmy_queue_samples`. There is one row per queue per
 * sampler tick, with the counts and the completed/failed events since the
 * previous tick. The table leads its sort key with `org_id`, every read
 * filters on it, and retention is TTL, like the other swarmy_* tables.
 */
import { z } from 'zod';

// ── Inputs (router schemas) ──────────────────────────────────────────────────

const stack = z.string().min(1).max(63).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'invalid stack name');
const cluster = z.string().min(1).max(40).regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/, 'invalid cluster name');
const prefix = z.string().regex(/^[A-Za-z0-9_.{}-]{1,64}$/).default('bull');
const queue = z.string().regex(/^[^:\s\p{Cc}]{1,200}$/u, 'a BullMQ queue name (no ":" or spaces)');
const jobId = z.string().regex(/^[^:\s\p{Cc}]{1,256}$/u, 'a BullMQ job id');
const state = z.enum(['wait', 'paused', 'active', 'prioritized', 'delayed', 'completed', 'failed', 'waiting-children']);
const cleanState = z.enum(['wait', 'paused', 'prioritized', 'delayed', 'completed', 'failed']);

/** A cache cluster the studio browses (`<stack>/<cluster>`). */
export const StudioClusterInput = z.object({ stack, cluster, prefix });
export type StudioClusterInput = z.infer<typeof StudioClusterInput>;
export const StudioQueueInput = StudioClusterInput.extend({ queue });
export type StudioQueueInput = z.infer<typeof StudioQueueInput>;

export const StudioJobsInput = StudioQueueInput.extend({
  state,
  start: z.number().int().min(0).max(10_000_000).default(0),
  count: z.number().int().min(1).max(100).default(25),
});
export type StudioJobsInput = z.infer<typeof StudioJobsInput>;

export const StudioJobInput = StudioQueueInput.extend({ id: jobId });
export type StudioJobInput = z.infer<typeof StudioJobInput>;

export const StudioRetryInput = StudioJobInput.extend({ from: z.enum(['failed', 'completed']).default('failed') });
export const StudioRetryAllInput = StudioQueueInput.extend({ from: z.enum(['failed', 'completed']).default('failed') });
export const StudioPauseInput = StudioQueueInput.extend({ paused: z.boolean() });
export const StudioCleanInput = StudioQueueInput.extend({
  state: cleanState,
  /** Keep jobs newer than this (ms). 0 = everything in the state. */
  graceMs: z.number().int().min(0).max(365 * 86_400_000).default(0),
  limit: z.number().int().min(1).max(10_000).default(1000),
});
export const StudioRatesInput = StudioQueueInput.extend({
  windowMinutes: z.number().int().min(5).max(7 * 24 * 60).default(60),
});
export type StudioRatesInput = z.infer<typeof StudioRatesInput>;

// ── Rate sampling ────────────────────────────────────────────────────────────

/** What one sampler tick keeps per queue (module memory; a restart re-seeds). */
export interface RateCursor {
  lastId: string | null;
  at: number;
}

export interface RatePoint {
  completed: number;
  failed: number;
  intervalSeconds: number;
  /** per minute */
  throughput: number;
  failureRate: number;
  /** failed / (completed + failed), 0..1; null with no finished jobs. */
  failureRatio: number | null;
  saturated: boolean;
}

/**
 * Turn one tick's event counts (completed/failed since `prev.lastId`) into a
 * rate point. Null on the seeding tick (no previous cursor), because there's
 * no interval to divide by yet.
 */
export function ratePoint(
  prev: RateCursor | undefined,
  now: number,
  events: { completed: number; failed: number; saturated: boolean },
): RatePoint | null {
  if (!prev?.lastId) return null;
  const intervalSeconds = Math.max(1, (now - prev.at) / 1000);
  const perMin = (n: number) => Math.round((n / intervalSeconds) * 60 * 100) / 100;
  const finished = events.completed + events.failed;
  return {
    completed: events.completed,
    failed: events.failed,
    intervalSeconds: Math.round(intervalSeconds),
    throughput: perMin(events.completed),
    failureRate: perMin(events.failed),
    failureRatio: finished > 0 ? Math.round((events.failed / finished) * 1000) / 1000 : null,
    saturated: events.saturated,
  };
}

// ── ClickHouse (observability store) ─────────────────────────────────────────

export const QUEUE_SAMPLES_TABLE = 'swarmy_queue_samples';

function ident(db: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(db)) throw new Error(`invalid ClickHouse database name ${db}`);
  return db;
}

function days(n: number): number {
  return Math.min(365, Math.max(1, Math.floor(Number.isFinite(n) ? n : 7)));
}

/** Idempotent DDL (create, then converge the TTL). Deterministic — golden-tested. */
export function renderQueueSamplesSchema(opts: { database: string; retentionDays: number }): string[] {
  const db = ident(opts.database);
  const ttl = days(opts.retentionDays);
  return [
    `CREATE TABLE IF NOT EXISTS ${db}.${QUEUE_SAMPLES_TABLE} (
  org_id LowCardinality(String),
  stack LowCardinality(String),
  cluster LowCardinality(String),
  prefix LowCardinality(String),
  queue String,
  ts DateTime64(3, 'UTC'),
  interval_s UInt32,
  waiting UInt64,
  active UInt64,
  delayed UInt64,
  prioritized UInt64,
  failed UInt64,
  completed UInt64,
  paused UInt8,
  completed_delta UInt64,
  failed_delta UInt64
) ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (org_id, stack, cluster, queue, ts)
TTL toDateTime(ts) + INTERVAL ${ttl} DAY`,
    `ALTER TABLE ${db}.${QUEUE_SAMPLES_TABLE} MODIFY TTL toDateTime(ts) + INTERVAL ${ttl} DAY`,
  ];
}

/** One JSONEachRow row (values never enter SQL text). */
export interface QueueSampleRow {
  org_id: string;
  stack: string;
  cluster: string;
  prefix: string;
  queue: string;
  ts: string;
  interval_s: number;
  waiting: number;
  active: number;
  delayed: number;
  prioritized: number;
  failed: number;
  completed: number;
  paused: number;
  completed_delta: number;
  failed_delta: number;
}

/** ClickHouse DateTime64 literal format (`YYYY-MM-DD hh:mm:ss.sss`, UTC). */
export function chTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
}

function lit(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** One bucketed point of the rates chart. */
export interface QueueRateBucket {
  bucket: string;
  completed: number;
  failed: number;
  seconds: number;
  waiting: number;
}

/**
 * Per-bucket completed/failed sums + mean backlog for one queue. Org-scoped
 * FIRST (the storage-layer invariant); the bucket width scales with the
 * window so a chart is ~60 points.
 */
export function buildQueueRatesQuery(
  database: string,
  orgId: string,
  q: { stack: string; cluster: string; prefix: string; queue: string; windowMinutes: number },
): string {
  const db = ident(database);
  const window = Math.min(7 * 24 * 60, Math.max(5, Math.floor(q.windowMinutes)));
  const bucket = Math.max(60, Math.floor((window * 60) / 60));
  return [
    'SELECT',
    `  toString(toStartOfInterval(ts, INTERVAL ${bucket} SECOND)) AS bucket,`,
    '  sum(completed_delta) AS completed,',
    '  sum(failed_delta) AS failed,',
    '  sum(interval_s) AS seconds,',
    '  round(avg(waiting), 1) AS waiting',
    `FROM ${db}.${QUEUE_SAMPLES_TABLE}`,
    `WHERE org_id = ${lit(orgId)} AND stack = ${lit(q.stack)} AND cluster = ${lit(q.cluster)}`,
    `  AND prefix = ${lit(q.prefix)} AND queue = ${lit(q.queue)}`,
    `  AND ts >= now64(3) - INTERVAL ${window} MINUTE`,
    'GROUP BY bucket',
    'ORDER BY bucket ASC',
  ].join('\n');
}
