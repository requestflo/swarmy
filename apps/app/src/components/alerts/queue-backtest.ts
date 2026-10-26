import type { AlertQueueHistoryView } from '@swarmy/core';
import type { BacktestSource } from './use-rule-backtest';

/**
 * A queue-depth rule's week to replay, from `alerts.queueHistory`: one
 * subject per worker part × queue, as the evaluator fires (each on its own),
 * the deepest backlog in each 5-minute slot. Pure — queue-backtest.test.ts.
 *
 * Honest about the gaps: a raw Redis list keeps no history, so it is named
 * as left out; a run counts whole 5-minute slots (the slot's peak was over
 * the line, not necessarily all of it); and a paused BullMQ queue's held
 * jobs count in the history while the live check reads a paused queue as 0.
 */
export function queueBacktestSource(v: AlertQueueHistoryView, target: string): BacktestSource {
  if (v.tooMany !== null) {
    return { state: 'empty', why: `Pick an app to replay this rule: ${target} means ${v.tooMany} queues, more than swarmy replays at once.` };
  }
  const left = v.untracked.length ? `${v.untracked.join(', ')} ${v.untracked.length === 1 ? 'is a raw list, which keeps' : 'are raw lists, which keep'} no history` : '';
  if (v.queues.length === 0) {
    return { state: 'empty', why: left ? `${left}, so there’s nothing to replay.` : `swarmy has no queue readings for ${target} from the last 7 days yet.` };
  }
  return {
    state: 'ready',
    grid: { from: Date.parse(v.from), stepMs: v.stepSeconds * 1000, slots: Math.max(...v.queues.map((q) => q.peaks.length)) },
    subjects: v.queues.map((q) => ({ name: q.name, values: q.peaks })),
    tech:
      `alerts.queueHistory · ${v.queues.length === 1 ? v.queues[0]!.name : `${v.queues.length} queues`} · the deepest backlog in each 5 minutes (QueueStatSample), ` +
      `so a run counts whole slots · a paused queue’s held jobs count here; the live check reads it as 0${left ? ` · left out: ${left}` : ''}`,
  };
}
