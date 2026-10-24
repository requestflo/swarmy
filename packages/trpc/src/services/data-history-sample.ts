import { DATA_HISTORY_SAMPLE_SECONDS, type QueueView } from '@swarmy/core';
import type { BullQueueSample } from '@swarmy/core/protocol';
import type { RatePoint } from './queue-studio.core';

/**
 * The pure half of the managed data history sampler: which 5-minute bucket a
 * reading belongs to, the once-per-bucket gate, the INFO counters a cache
 * keeps, and how a BullMQ queue's 15-second ticks fold into one row per
 * bucket. The writes are in `data-history-record.ts`.
 */

export const DATA_SAMPLE_MS = DATA_HISTORY_SAMPLE_SECONDS * 1000;

/** The start (ms) of the 5-minute bucket holding `now`. */
export function sampleBucketStart(now: number): number {
  return Math.floor(now / DATA_SAMPLE_MS) * DATA_SAMPLE_MS;
}

/**
 * Interval gate: each key is due once per bucket. `due` answers the bucket
 * to write, or null when that bucket (or a later one) already has its row;
 * `mark` records a write.
 */
export class BucketGate {
  private readonly last = new Map<string, number>();

  due(key: string, now: number): number | null {
    const bucket = sampleBucketStart(now);
    return (this.last.get(key) ?? Number.NEGATIVE_INFINITY) >= bucket ? null : bucket;
  }

  mark(key: string, bucket: number): void {
    this.last.set(key, bucket);
  }

  clear(): void {
    this.last.clear();
  }
}

/** What a cache keeps per bucket: cumulative keyspace counters, ops/s, memory. */
export interface CacheCounters {
  hits: number;
  misses: number;
  opsPerSec: number;
  usedMemoryBytes: number;
}

/** An INFO reply → the counters history keeps (null when it isn't one). */
export function cacheCountersOf(raw: string): CacheCounters | null {
  const fields = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    const i = t.indexOf(':');
    if (t.startsWith('#') || i <= 0) continue;
    fields.set(t.slice(0, i), t.slice(i + 1));
  }
  if (!fields.has('used_memory')) return null;
  const n = (k: string): number => {
    const v = Number(fields.get(k));
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  };
  return {
    hits: n('keyspace_hits'),
    misses: n('keyspace_misses'),
    opsPerSec: n('instantaneous_ops_per_sec'),
    usedMemoryBytes: n('used_memory'),
  };
}

/** One sampler tick of one queue. Null = not measured this tick. */
export interface QueueTick {
  waiting: number;
  active: number;
  completed: number | null;
  failed: number | null;
  workers: number | null;
}

/** A queue's open bucket: peaks of the gauges, sums of the finished jobs. */
export interface QueueBucket extends QueueTick {
  bucket: number;
}

/** A sampled queue + its rate point → the tick history keeps. Depth counts paused and prioritized jobs too. */
export function queueTickOf(q: BullQueueSample, rate: RatePoint | null, workers: number | null): QueueTick {
  return {
    waiting: q.counts.wait + q.counts.paused + q.counts.prioritized,
    active: q.counts.active,
    completed: rate ? rate.completed : null,
    failed: rate ? rate.failed : null,
    workers,
  };
}

const sum = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : a + b);
const peak = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));

/**
 * Fold one tick into a queue's open bucket. Within a bucket the gauges keep
 * their peak (a spike never averages away) and finished jobs add up. A tick
 * in a later bucket closes the open one and hands it back to write, so each
 * bucket is written once, after it ends.
 */
export function foldQueueTick(
  open: QueueBucket | undefined,
  now: number,
  tick: QueueTick,
): { open: QueueBucket; closed: QueueBucket | null } {
  const bucket = sampleBucketStart(now);
  if (!open || open.bucket < bucket) return { open: { bucket, ...tick }, closed: open ?? null };
  if (open.bucket > bucket) return { open, closed: null }; // the clock stepped back: keep the open bucket
  return {
    open: {
      bucket,
      waiting: Math.max(open.waiting, tick.waiting),
      active: Math.max(open.active, tick.active),
      workers: peak(open.workers, tick.workers),
      completed: sum(open.completed, tick.completed),
      failed: sum(open.failed, tick.failed),
    },
    closed: null,
  };
}

/** `<cache stack>/<cache cluster>/<queue>` → worker copies running across the BullMQ defs consuming it. */
export function workersByQueue(queues: readonly QueueView[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const q of queues) {
    if (q.convention !== 'bullmq') continue;
    const key = `${q.cacheStack}/${q.cacheName}/${q.name}`;
    out.set(key, (out.get(key) ?? 0) + q.workers.running);
  }
  return out;
}
