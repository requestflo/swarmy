import { QueueDepthHistoryInput, type QueueDepthHistoryView } from '@swarmy/core';
import { telemetryOf, type OrgContext } from '../context';
import { historyWindow, slotGrid, type SlotRow } from './data-history-grid';

/**
 * `queues.depthHistory` — one BullMQ queue's depth, worker copies and
 * finished jobs over the last 6 hours (by default), for the queue studio's
 * "depth vs workers" and the Jobs tab's "today N". Read-only, org-scoped:
 * rows are filtered on the caller's org. telemetry.db keeps one row per
 * queue per 5 minutes (the queue-reconcile sampler); the SQL folds them into
 * display slots: the deepest backlog and the most copies in a slot (peaks),
 * and the jobs finished in it (sums). A slot nobody measured stays null.
 */

const KEYS = ['waiting', 'active', 'workers', 'completed', 'failed'] as const;
export type QueueSlotRow = SlotRow<(typeof KEYS)[number]>;

export async function queueDepthHistory(
  ctx: OrgContext,
  raw: QueueDepthHistoryInput,
  now = Date.now(),
): Promise<QueueDepthHistoryView> {
  const input = QueueDepthHistoryInput.parse(raw);
  const w = historyWindow(input.hours, now);
  const step = w.step;
  const rows = await telemetryOf(ctx)
    .$queryRaw<QueueSlotRow[]>`
      SELECT CAST(strftime('%s', "bucketStart") AS INTEGER) / CAST(${step} AS INTEGER) AS "slot",
             MAX("waiting") AS "waiting",
             MAX("active") AS "active",
             MAX("workers") AS "workers",
             SUM("completed") AS "completed",
             SUM("failed") AS "failed"
      FROM "queue_stat_sample"
      WHERE "orgId" = ${ctx.activeOrgId} AND "stack" = ${input.stack} AND "cluster" = ${input.cluster}
        AND "prefix" = ${input.prefix} AND "queue" = ${input.queue}
        AND "bucketStart" >= ${new Date(w.from)}
      GROUP BY 1`
    // telemetry unavailable: no history to draw (the chart says so).
    .catch(() => [] as QueueSlotRow[]);
  return { from: new Date(w.from).toISOString(), stepSeconds: step, ...slotGrid(rows, KEYS, w) };
}
