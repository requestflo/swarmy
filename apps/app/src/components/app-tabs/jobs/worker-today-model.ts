import type { QueueDepthHistoryView } from '@swarmy/core';
import { addSeries, sumSince, type HistoryGrid } from '@/components/history/history-model';

/**
 * A worker's "today N" (board AppJobs): jobs its BullMQ queues finished
 * since local midnight, from each queue's `queues.depthHistory` (24 h,
 * 15-minute slots), plus the summed per-slot series for its sparkline.
 * `today` is null when no slot since midnight was measured — "not measured
 * yet", never a made-up 0. PURE — unit-tested in worker-today-model.test.ts.
 */

export interface WorkerToday {
  today: number | null;
  /** Jobs done per slot, every queue added up. */
  done: Array<number | null>;
  grid: HistoryGrid | null;
}

export function workerToday(views: ReadonlyArray<QueueDepthHistoryView>, midnightMs: number): WorkerToday {
  const first = views[0];
  if (!first) return { today: null, done: [], grid: null };
  const grid = { from: first.from, stepSeconds: first.stepSeconds };
  const done = addSeries(views.map((v) => v.completed));
  const s = sumSince(grid, done, midnightMs);
  return { today: s.measured ? s.total : null, done, grid };
}

/** Local midnight of `now`. */
export function localMidnight(now: Date): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
