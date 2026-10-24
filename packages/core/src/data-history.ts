import { z } from 'zod';

/**
 * Managed data history: trends for caches, queues and buckets, read out of
 * telemetry.db. The reconcile workers keep one row per resource per
 * 5-minute bucket for 7 days; each read folds those rows into a fixed grid
 * of display slots in SQL, the same shape as `nodes.statsHistory`. Point `i`
 * covers the slot starting at `from + i * stepSeconds`; the last slot holds
 * "now" (still filling). A slot with no reading is null, never a zero.
 */

/** The sampling bucket: at most one row per resource per 5 minutes. */
export const DATA_HISTORY_SAMPLE_SECONDS = 300;
/** Rows older than this are pruned by the hourly telemetry retention. */
export const DATA_HISTORY_RETENTION_DAYS = 7;

/** Display slot for a window: 5 min up to 6 h, 15 min up to 24 h, 1 h beyond. */
export function dataHistoryStepSeconds(hours: number): number {
  if (hours <= 6) return 300;
  if (hours <= 24) return 900;
  return 3600;
}

/** Slots in a window of `hours` at its display step. */
export function dataHistorySlots(hours: number): number {
  return Math.ceil((hours * 3600) / dataHistoryStepSeconds(hours));
}

const name = z.string().min(1).max(128);
const hours = (fallback: number) => z.number().int().min(1).max(DATA_HISTORY_RETENTION_DAYS * 24).default(fallback);

/** One value per slot; null where nothing was sampled. */
export type DataHistorySeries = Array<number | null>;

interface Grid {
  from: string;
  stepSeconds: number;
}

/** `cache.statsHistory` — one managed cache, by default the last 24 hours. */
export const CacheStatsHistoryInput = z.object({ stack: name, cluster: name, hours: hours(24) });
export type CacheStatsHistoryInput = z.input<typeof CacheStatsHistoryInput>;

export interface CacheStatsHistoryView extends Grid {
  /** Hits ÷ lookups made during the slot, 0–100; null with no lookups. */
  hitRatePct: DataHistorySeries;
  /** Lookups during the slot (hits + misses). */
  lookups: DataHistorySeries;
  /** Busiest ops/s reading in the slot. */
  opsPerSec: DataHistorySeries;
  /** Highest memory reading in the slot (bytes). */
  usedMemoryBytes: DataHistorySeries;
}

/** `queues.depthHistory` — one BullMQ queue on a managed cache, by default 6 hours. */
export const QueueDepthHistoryInput = z.object({
  stack: name,
  cluster: name,
  queue: name,
  prefix: z.string().min(1).max(64).default('bull'),
  hours: hours(6),
});
export type QueueDepthHistoryInput = z.input<typeof QueueDepthHistoryInput>;

export interface QueueDepthHistoryView extends Grid {
  /** Deepest backlog in the slot (waiting + paused + prioritized). */
  waiting: DataHistorySeries;
  active: DataHistorySeries;
  /** Most worker copies running in the slot. */
  workers: DataHistorySeries;
  /** Jobs finished during the slot. */
  completed: DataHistorySeries;
  failed: DataHistorySeries;
}

/** `buckets.sizeHistory` — one Garage bucket, by default the last 7 days in hourly slots. */
export const BucketSizeHistoryInput = z.object({ bucketId: name, hours: hours(DATA_HISTORY_RETENTION_DAYS * 24) });
export type BucketSizeHistoryInput = z.input<typeof BucketSizeHistoryInput>;

export interface BucketSizeHistoryView extends Grid {
  /** Largest size reading in the slot. */
  bytes: DataHistorySeries;
  objects: DataHistorySeries;
}
