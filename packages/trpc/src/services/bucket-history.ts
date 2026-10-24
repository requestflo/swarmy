import { BucketSizeHistoryInput, type BucketSizeHistoryView } from '@swarmy/core';
import { telemetryOf, type OrgContext } from '../context';
import { historyWindow, slotGrid, type SlotRow } from './data-history-grid';

/**
 * `buckets.sizeHistory` — one Garage bucket's size and object count over the
 * last 7 days (by default) in hourly slots, for the bucket page's "+X this
 * week · full in ~N". Read-only, org-scoped: rows are filtered on the
 * caller's org, so another org's bucket id never shows. telemetry.db keeps
 * one reading per bucket per 5 minutes (storage-reconcile); a slot holds its
 * largest reading. The growth and forecast maths is the page's (it knows the
 * quota); this only folds.
 */

const KEYS = ['bytes', 'objects'] as const;
export type BucketSlotRow = SlotRow<(typeof KEYS)[number]>;

export async function bucketSizeHistory(
  ctx: OrgContext,
  raw: BucketSizeHistoryInput,
  now = Date.now(),
): Promise<BucketSizeHistoryView> {
  const input = BucketSizeHistoryInput.parse(raw);
  const w = historyWindow(input.hours, now);
  const step = w.step;
  const rows = await telemetryOf(ctx)
    .$queryRaw<BucketSlotRow[]>`
      SELECT CAST(strftime('%s', "bucketStart") AS INTEGER) / CAST(${step} AS INTEGER) AS "slot",
             MAX("bytes") AS "bytes",
             MAX("objects") AS "objects"
      FROM "bucket_stat_sample"
      WHERE "orgId" = ${ctx.activeOrgId} AND "bucketId" = ${input.bucketId}
        AND "bucketStart" >= ${new Date(w.from)}
      GROUP BY 1`
    // telemetry unavailable: no history (the page says so).
    .catch(() => [] as BucketSlotRow[]);
  return { from: new Date(w.from).toISOString(), stepSeconds: step, ...slotGrid(rows, KEYS, w) };
}
