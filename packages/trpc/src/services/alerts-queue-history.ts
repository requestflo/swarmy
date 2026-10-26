import { selectorMatches, subjectFromResource, type AlertQueueHistoryInput, type AlertQueueHistoryView, type QueueView } from '@swarmy/core';
import { telemetryOf, type OrgContext } from '../context';
import { DISK_HISTORY_DAYS, diskGridFrom } from './alerts-disk-history';
import { slotGrid, type HistoryWindow, type SlotRow } from './data-history-grid';
import { listQueues } from './queues.service';

/**
 * `alerts.queueHistory` — what a queue-depth rule would have seen over the
 * last week, for the rule editor's "would have fired" backtest. The subjects
 * are the evaluator's: one per worker part × queue (`queue:<service>/<queue>`),
 * kept only when the rule's target covers it (`selectorMatches`, the same
 * call the evaluator makes). Each one's history is its BullMQ queue's
 * QueueStatSample rows (telemetry.db, one per queue per 5 minutes, the
 * deepest backlog in it), read per queue and org-scoped. A raw-list queue
 * keeps no history, so it is named as left out rather than drawn flat.
 */

export const QUEUE_HISTORY_STEP_SECONDS = 300;
/** More watched queues than this and the editor asks for one app. */
export const QUEUE_HISTORY_MAX = 20;
const SLOTS = (DISK_HISTORY_DAYS * 86_400) / QUEUE_HISTORY_STEP_SECONDS;

export type QueuePeakRow = SlotRow<'peak'>;

/** "storefront / worker · emails": the evaluator's subject, then the queue. */
export function queueSubjectName(q: Pick<QueueView, 'workerService' | 'stack' | 'name'>): string {
  const part = q.workerService.startsWith(`${q.stack}_`) ? q.workerService.slice(q.stack.length + 1) : q.workerService;
  return `${q.stack ? `${q.stack} / ` : ''}${part} · ${q.name}`;
}

/** The queues a rule with this target watches, as the evaluator sees them. Pure. */
export function watchedQueues(queues: readonly QueueView[], sel: AlertQueueHistoryInput): QueueView[] {
  return queues.filter((q) => selectorMatches(sel, subjectFromResource(`queue:${q.workerService}/${q.name}`)));
}

export function queueHistoryWindow(now: number): HistoryWindow {
  return { step: QUEUE_HISTORY_STEP_SECONDS, slots: SLOTS, from: diskGridFrom(now, QUEUE_HISTORY_STEP_SECONDS, SLOTS) };
}

export async function queueHistory(ctx: OrgContext, input: AlertQueueHistoryInput, now = Date.now()): Promise<AlertQueueHistoryView> {
  const w = queueHistoryWindow(now);
  const watched = watchedQueues(listQueues(ctx), input);
  const tracked = watched.filter((q) => q.convention === 'bullmq');
  const view = { from: new Date(w.from).toISOString(), stepSeconds: w.step, untracked: watched.filter((q) => q.convention !== 'bullmq').map(queueSubjectName) };
  if (tracked.length > QUEUE_HISTORY_MAX) return { ...view, queues: [], tooMany: tracked.length };
  const tdb = telemetryOf(ctx);
  const queues = await Promise.all(
    tracked.map(async (q) => {
      const step = w.step;
      // The deepest backlog per slot, across key prefixes (the live check keys queues without one).
      const rows = await tdb
        .$queryRaw<QueuePeakRow[]>`
          SELECT CAST(strftime('%s', "bucketStart") AS INTEGER) / CAST(${step} AS INTEGER) AS "slot", MAX("waiting") AS "peak"
          FROM "queue_stat_sample"
          WHERE "orgId" = ${ctx.activeOrgId} AND "stack" = ${q.cacheStack} AND "cluster" = ${q.cacheName} AND "queue" = ${q.name}
            AND "bucketStart" >= ${new Date(w.from)}
          GROUP BY 1`
        // telemetry unavailable: no history to replay (the editor says so).
        .catch(() => [] as QueuePeakRow[]);
      return { name: queueSubjectName(q), peaks: slotGrid(rows, ['peak'] as const, w).peak };
    }),
  );
  return { ...view, queues: queues.filter((q) => q.peaks.some((v) => v !== null)).sort((a, b) => a.name.localeCompare(b.name)), tooMany: null };
}
