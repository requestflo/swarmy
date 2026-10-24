import { describe, expect, it } from 'bun:test';
import type { QueueDef, QueueDepthSample } from '@swarmy/core';
import { planWorkerTick, type WorkerMemo, type WorkerTick } from './queue-reconcile.core';

const T0 = Date.parse('2026-10-24T10:00:00.000Z');
const MIN = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const DEF: QueueDef = {
  name: 'emails',
  cacheCluster: 'jobs',
  convention: 'bullmq',
  scalePerJobs: 25,
  minWorkers: 1,
  maxWorkers: 4,
  cooldownSeconds: 600,
  retries: 3,
  dlq: true,
};
const sample = (wait: number, at: number): QueueDepthSample => ({ wait, active: 0, failed: 0, delayed: 0, ts: iso(at) });

/** A worker whose labels follow every write the plan makes (a fresh inventory each tick). */
function sim(current: number) {
  const live: { stats?: string; calm?: string; current: number } = { current };
  let memo: WorkerMemo | undefined;
  const writes: string[] = [];
  return {
    live,
    writes,
    forget: (): void => {
      memo = undefined; // a controller restart: memory gone, labels kept
    },
    tick(wait: number | null, now: number) {
      const t: WorkerTick = {
        defs: [DEF],
        fresh: new Map(wait === null ? [] : [['emails', sample(wait, now)]]),
        prevStats: live.stats ? (JSON.parse(live.stats) as Record<string, QueueDepthSample>) : {},
        liveStats: live.stats,
        liveCalm: live.calm,
        current: live.current,
        scalable: true,
        now,
      };
      const plan = planWorkerTick(t, memo);
      memo = plan.memo;
      if (plan.stats) live.stats = plan.stats;
      if (plan.calm === null) delete live.calm;
      else if (plan.calm !== undefined) {
        live.calm = plan.calm;
        writes.push(`calm ${plan.calm}`);
      }
      if (plan.scale !== null) {
        writes.push(`scale ${plan.scale}`);
        live.current = plan.scale;
        if (memo) memo = { ...memo, pushed: { replicas: plan.scale, at: now } };
      }
      return plan;
    },
  };
}

describe('queue-reconcile — one worker tick', () => {
  it('scales up at once, then holds through the calm and drops after 10 min', () => {
    const w = sim(1);
    expect(w.tick(100, T0).scale).toBe(4);
    for (let m = 1; m < 10; m++) expect(w.tick(0, T0 + m * MIN).scale).toBeNull();
    expect(w.live.current).toBe(4);
    expect(w.tick(0, T0 + 11 * MIN).scale).toBe(1);
    expect(w.live.calm).toBeUndefined();
  });

  it('a steady tick writes nothing but the stats stamp', () => {
    const w = sim(2);
    w.tick(30, T0);
    w.writes.length = 0;
    const plan = w.tick(40, T0 + 15_000);
    expect([plan.scale, plan.calm]).toEqual([null, undefined]);
    expect(w.writes).toEqual([]);
  });

  it('the calm clock survives a controller restart (read back off the label)', () => {
    const w = sim(4);
    for (let m = 0; m <= 6; m++) w.tick(0, T0 + m * MIN);
    w.forget();
    expect(w.tick(0, T0 + 7 * MIN).step).toMatchObject({ move: 'calming', calm: { since: iso(T0) } });
    expect(w.tick(0, T0 + 10 * MIN).scale).toBe(1);
  });

  it('never scales off a tick that measured nothing, and keeps the last stamp', () => {
    const w = sim(4);
    w.tick(0, T0);
    const plan = w.tick(null, T0 + 20 * MIN);
    expect([plan.scale, plan.calm, plan.stats]).toEqual([null, undefined, null]);
  });

  it('a push the inventory has not shown yet is not sent twice', () => {
    const w = sim(1);
    expect(w.tick(100, T0).scale).toBe(4);
    w.live.current = 1; // the next snapshot still says 1
    expect(w.tick(100, T0 + 15_000).scale).toBeNull();
    expect(w.tick(100, T0 + 2 * MIN).scale).toBe(4); // re-sent after the retry window
  });
});
