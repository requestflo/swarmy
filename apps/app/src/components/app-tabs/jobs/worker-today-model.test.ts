import { describe, expect, it } from 'bun:test';
import type { QueueDepthHistoryView } from '@swarmy/core';
import { localMidnight, workerToday } from './worker-today-model';

const FROM = '2026-10-23T12:00:00.000Z';
const T0 = Date.parse(FROM);
const view = (completed: Array<number | null>): QueueDepthHistoryView => ({
  from: FROM,
  stepSeconds: 900,
  waiting: completed.map(() => 0),
  active: completed.map(() => 0),
  workers: completed.map(() => 1),
  completed,
  failed: completed.map(() => 0),
});

describe('workerToday', () => {
  it('adds every queue slot by slot and counts the slots since midnight', () => {
    const t = workerToday([view([100, 5, 7, null]), view([null, 1, null, 2])], T0 + 900_000);
    expect(t.done).toEqual([100, 6, 7, 2]);
    expect(t.today).toBe(15);
    expect(t.grid).toEqual({ from: FROM, stepSeconds: 900 });
  });

  it('no measured slot since midnight is "not measured yet" (null), not 0', () => {
    expect(workerToday([view([40, null, null])], T0 + 900_000).today).toBeNull();
    expect(workerToday([], T0)).toEqual({ today: null, done: [], grid: null });
  });

  it('a measured quiet day is a real 0', () => {
    expect(workerToday([view([40, 0, 0])], T0 + 900_000).today).toBe(0);
  });
});

describe('localMidnight', () => {
  it('is the start of the local day', () => {
    const m = new Date(localMidnight(new Date(2026, 9, 24, 15, 42)));
    expect([m.getFullYear(), m.getMonth(), m.getDate(), m.getHours(), m.getMinutes()]).toEqual([2026, 9, 24, 0, 0]);
  });
});
