import { describe, expect, it } from 'bun:test';
import type { AlertQueueHistoryView } from '@swarmy/core';
import { queueBacktestSource } from './queue-backtest';
import { backtest } from './rule-backtest';

const MIN = 60_000;
const FROM = '2026-10-17T12:05:00.000Z';
const at = (i: number) => Date.parse(FROM) + i * 5 * MIN;
const peaks = (...v: Array<number | null>) => [...v, ...new Array<number | null>(12 - v.length).fill(null)];
const view = (over: Partial<AlertQueueHistoryView>): AlertQueueHistoryView => ({ from: FROM, stepSeconds: 300, queues: [], untracked: [], tooMany: null, ...over });

describe('queue-depth backtest — the evaluator’s rule over each queue’s week', () => {
  // storefront's email queue backs up twice: 1,200 for one slot, then 1,400–2,600 for three; billing never does.
  const emails = { name: 'storefront / worker · emails', peaks: peaks(40, 1_200, 80, 1_400, 2_600, 1_800, 30, null, 20, 1_001, 1_000, 0) };
  const billing = { name: 'billing / worker · invoices', peaks: peaks(5, 9, 3) };
  const src = queueBacktestSource(view({ queues: [emails, billing] }), 'any app');

  it('ready: one subject per worker part × queue on the history’s grid', () => {
    if (src.state !== 'ready') throw new Error(src.state);
    expect(src.grid).toEqual({ from: Date.parse(FROM), stepMs: 5 * MIN, slots: 12 });
    expect(src.subjects.map((s) => s.name)).toEqual(['storefront / worker · emails', 'billing / worker · invoices']);
    expect(src.tech).toContain('a paused queue’s held jobs count here');
  });

  it('strictly above 1,000 jobs fires per stretch; a for-duration skips the one-slot spikes', () => {
    if (src.state !== 'ready') throw new Error(src.state);
    const now = backtest(src.subjects, src.grid, 1_000, 0);
    expect(now.fires.map((f) => [f.subject, (f.start - at(0)) / MIN, (f.end - at(0)) / MIN, f.peak])).toEqual([
      ['storefront / worker · emails', 5, 10, 1_200],
      ['storefront / worker · emails', 15, 30, 2_600],
      ['storefront / worker · emails', 45, 50, 1_001],
    ]);
    const held = backtest(src.subjects, src.grid, 1_000, 600);
    expect([held.fires.map((f) => f.peak), held.blips]).toEqual([[2_600], 2]);
    expect(backtest(src.subjects, src.grid, 5_000, 0).fires).toEqual([]);
  });

  it('a gap is no reading, never a zero, and never over the line', () => {
    if (src.state !== 'ready') throw new Error(src.state);
    // Over 10 jobs from slot 0 to 6, a gap at 7, over again 8–10: the gap ends the first run.
    const r = backtest(src.subjects, src.grid, 10, 1_800);
    expect([r.fires.map((f) => [(f.start - at(0)) / MIN, (f.end - at(0)) / MIN]), r.blips]).toEqual([[[0, 35]], 1]);
  });

  it('raw lists are named as left out; with nothing else there is nothing to replay', () => {
    const mixed = queueBacktestSource(view({ queues: [billing], untracked: ['storefront / worker · outbox'] }), 'any app');
    expect(mixed.state === 'ready' && mixed.tech).toContain('left out: storefront / worker · outbox is a raw list, which keeps no history');
    expect(queueBacktestSource(view({ untracked: ['a · x', 'b · y'] }), 'any app')).toEqual({ state: 'empty', why: 'a · x, b · y are raw lists, which keep no history, so there’s nothing to replay.' });
  });

  it('no readings, or too many queues to replay at once, say why', () => {
    expect(queueBacktestSource(view({}), 'storefront')).toEqual({ state: 'empty', why: 'swarmy has no queue readings for storefront from the last 7 days yet.' });
    expect(queueBacktestSource(view({ tooMany: 31 }), 'any app').state).toBe('empty');
  });
});
