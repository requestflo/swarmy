import { MINUTE_MS, type TrafficRollupRow } from './edge-traffic';
import { addExtras } from './edge-traffic-extras';

/**
 * Per-edge request counting (Q4) — the hourly tier. The 5-minute rollups
 * live 7 days; a four-week chart reads these instead: the same rows folded
 * to one per (edge, host, hour), kept 35 days.
 *
 * The fold is a pure function of one hour's 5-minute rows, and the worker
 * UPSERTS its result (never increments), so folding an hour twice — after a
 * restart, or because the mark was re-read — writes the same numbers.
 */

/** Hourly rollup width. */
export const TRAFFIC_HOUR_MS = 60 * MINUTE_MS;
/** Hourly rollups are kept for 35 days (four weeks plus a margin). */
export const TRAFFIC_HOURLY_RETENTION_MS = 35 * 24 * TRAFFIC_HOUR_MS;
/** At most this many hours folded per org per worker tick (a backfill catches up over ticks). */
export const TRAFFIC_FOLD_HOURS_PER_TICK = 24;

export const hourOf = (ms: number): number => Math.floor(ms / TRAFFIC_HOUR_MS) * TRAFFIC_HOUR_MS;

/** A 5-minute rollup as stored: the counts plus the region/app resolved when it was written. */
export interface StoredTrafficRollup extends TrafficRollupRow {
  region: string | null;
  app: string | null;
}

/**
 * Fold 5-minute rows into one row per (hour, edge, host). Counts and 403/429
 * add up (an unreported 403 stays unreported unless another row reported
 * one); duration buckets merge. Region and app come from the hour's NEWEST
 * row, so a route that moved mid-hour lands where it lives now. The coverage
 * row (`host: ''`) folds like any other, so an hour any edge reported in
 * stays covered.
 */
export function foldTrafficHours(rows: readonly StoredTrafficRollup[]): StoredTrafficRollup[] {
  const acc = new Map<string, { row: StoredTrafficRollup; newest: number }>();
  for (const r of rows) {
    const hour = hourOf(r.bucketStart);
    const key = `${hour}\u0000${r.nodeId}\u0000${r.host}`;
    let cur = acc.get(key);
    if (!cur) {
      cur = {
        row: { bucketStart: hour, nodeId: r.nodeId, host: r.host, region: r.region, app: r.app, requests: 0, errors5xx: 0 },
        newest: r.bucketStart,
      };
      acc.set(key, cur);
    }
    cur.row.requests += r.requests;
    cur.row.errors5xx += r.errors5xx;
    addExtras(cur.row, r);
    if (r.bucketStart >= cur.newest) {
      cur.newest = r.bucketStart;
      cur.row.region = r.region;
      cur.row.app = r.app;
    }
  }
  return [...acc.values()]
    .map((v) => v.row)
    .sort((a, b) => a.bucketStart - b.bucketStart || cmp(a.nodeId, b.nodeId) || cmp(a.host, b.host));
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The hours ready to fold: every hour from `mark` (inclusive) whose end is at
 * or before `flushedTo` — the 5-minute flush watermark, so each folded hour's
 * 5-minute rows are all written. At most `max`, oldest first.
 */
export function hoursToFold(mark: number, flushedTo: number, max = TRAFFIC_FOLD_HOURS_PER_TICK): number[] {
  const out: number[] = [];
  for (let h = hourOf(mark); h + TRAFFIC_HOUR_MS <= flushedTo && out.length < max; h += TRAFFIC_HOUR_MS) out.push(h);
  return out;
}

/**
 * Where an org's fold starts after a (re)start: the hour after the newest
 * folded hour; with none, the first whole hour of the 5-minute table (a
 * backfill of the week it still holds; its oldest hour is part-pruned); with
 * neither, the hour the process started in.
 */
export function firstHourToFold(args: { newestFolded: number | null; oldestRollup: number | null; boot: number }): number {
  if (args.newestFolded !== null) return hourOf(args.newestFolded) + TRAFFIC_HOUR_MS;
  if (args.oldestRollup !== null) return Math.ceil(args.oldestRollup / TRAFFIC_HOUR_MS) * TRAFFIC_HOUR_MS;
  return hourOf(args.boot);
}
