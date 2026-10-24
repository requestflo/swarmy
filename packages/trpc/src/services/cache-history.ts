import {
  CacheStatsHistoryInput,
  DATA_HISTORY_SAMPLE_SECONDS,
  type CacheStatsHistoryView,
} from '@swarmy/core';
import { telemetryOf, type OrgContext } from '../context';
import { historyWindow, slotGrid, type HistoryWindow, type SlotRow } from './data-history-grid';

/**
 * `cache.statsHistory` — one managed cache's hit rate, ops/s and memory over
 * the last day (by default), for the Data tab's "Hit rate · 24 h". Read-only,
 * org-scoped: rows are filtered on the caller's org, so another org's cache
 * of the same name never shows. telemetry.db keeps the primary's cumulative
 * keyspace counters once per 5 minutes (cache-reconcile); the SQL diffs each
 * row against the one before it (LAG) and sums the differences per slot, so
 * a slot's hit rate is the share of THAT slot's lookups that hit. A counter
 * that went down (the engine restarted) skips that interval.
 */

const KEYS = ['hits', 'misses', 'ops', 'mem'] as const;
export type CacheSlotRow = SlotRow<(typeof KEYS)[number]>;

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Slot rows → the view's series. Pure. No lookups in a slot = no hit rate (null), never 0%. */
export function cacheHistoryGrid(rows: ReadonlyArray<CacheSlotRow>, w: HistoryWindow): Omit<CacheStatsHistoryView, 'from' | 'stepSeconds'> {
  const g = slotGrid(rows, KEYS, w);
  const lookups = g.hits.map((h, i) => {
    const m = g.misses[i];
    return h === null || m === null || m === undefined ? null : h + m;
  });
  const hitRatePct = lookups.map((l, i) => (l !== null && l > 0 ? round1(((g.hits[i] ?? 0) * 100) / l) : null));
  return { hitRatePct, lookups, opsPerSec: g.ops, usedMemoryBytes: g.mem };
}

export async function cacheStatsHistory(
  ctx: OrgContext,
  raw: CacheStatsHistoryInput,
  now = Date.now(),
): Promise<CacheStatsHistoryView> {
  const input = CacheStatsHistoryInput.parse(raw);
  const w = historyWindow(input.hours, now);
  const step = w.step;
  // One sample before the window, so the first slot has a row to diff against.
  // `bucketStart` is ISO-8601 text (the bun-sqlite adapter): strftime reads it,
  // and a Date bound parameter compares as the same text.
  const rows = await telemetryOf(ctx)
    .$queryRaw<CacheSlotRow[]>`
      WITH d AS (
        SELECT "bucketStart",
               "hits" - LAG("hits") OVER w AS "dh",
               "misses" - LAG("misses") OVER w AS "dm",
               "opsPerSec", "usedMemoryBytes"
        FROM "cache_stat_sample"
        WHERE "orgId" = ${ctx.activeOrgId} AND "stack" = ${input.stack} AND "cluster" = ${input.cluster}
          AND "bucketStart" >= ${new Date(w.from - DATA_HISTORY_SAMPLE_SECONDS * 1000)}
        WINDOW w AS (ORDER BY "bucketStart")
      )
      SELECT CAST(strftime('%s', "bucketStart") AS INTEGER) / CAST(${step} AS INTEGER) AS "slot",
             SUM(CASE WHEN "dh" >= 0 AND "dm" >= 0 THEN "dh" END) AS "hits",
             SUM(CASE WHEN "dh" >= 0 AND "dm" >= 0 THEN "dm" END) AS "misses",
             MAX("opsPerSec") AS "ops",
             MAX("usedMemoryBytes") AS "mem"
      FROM d
      WHERE "bucketStart" >= ${new Date(w.from)}
      GROUP BY 1`
    // telemetry unavailable: no history to draw (the block says so).
    .catch(() => [] as CacheSlotRow[]);
  return { from: new Date(w.from).toISOString(), stepSeconds: step, ...cacheHistoryGrid(rows, w) };
}
