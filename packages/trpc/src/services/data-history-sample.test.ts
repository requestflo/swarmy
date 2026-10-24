import { describe, expect, it } from 'bun:test';
import type { QueueView } from '@swarmy/core';
import {
  BucketGate,
  DATA_SAMPLE_MS,
  cacheCountersOf,
  foldQueueTick,
  queueTickOf,
  sampleBucketStart,
  workersByQueue,
  type QueueTick,
} from './data-history-sample';

const T0 = Date.UTC(2026, 9, 24, 12, 0, 0);
const at = (minutes: number, seconds = 0): number => T0 + minutes * 60_000 + seconds * 1000;

describe('sampleBucketStart', () => {
  it('floors to the 5-minute bucket', () => {
    expect(DATA_SAMPLE_MS).toBe(300_000);
    expect(sampleBucketStart(at(0))).toBe(T0);
    expect(sampleBucketStart(at(4, 59))).toBe(T0);
    expect(sampleBucketStart(at(5))).toBe(at(5));
  });
});

describe('BucketGate — at most one row per resource per bucket', () => {
  it('is due once per bucket and per key, again in the next bucket', () => {
    const g = new BucketGate();
    expect(g.due('a', at(1))).toBe(T0);
    g.mark('a', T0);
    expect(g.due('a', at(4, 30))).toBeNull();
    expect(g.due('b', at(4, 30))).toBe(T0);
    expect(g.due('a', at(5, 1))).toBe(at(5));
  });

  it('a clock that steps back never re-opens a written bucket', () => {
    const g = new BucketGate();
    g.mark('a', at(10));
    expect(g.due('a', at(7))).toBeNull();
  });
});

describe('cacheCountersOf', () => {
  it('keeps the cumulative keyspace counters, ops/s and memory from INFO', () => {
    const raw = '# Stats\r\nkeyspace_hits:9700\r\nkeyspace_misses:300\r\ninstantaneous_ops_per_sec:4100\r\n# Memory\r\nused_memory:52428800\r\n';
    expect(cacheCountersOf(raw)).toEqual({ hits: 9700, misses: 300, opsPerSec: 4100, usedMemoryBytes: 52_428_800 });
  });

  it('is null for anything that is not an INFO reply; a missing counter reads 0', () => {
    expect(cacheCountersOf('NOAUTH Authentication required.')).toBeNull();
    expect(cacheCountersOf('used_memory:10')).toEqual({ hits: 0, misses: 0, opsPerSec: 0, usedMemoryBytes: 10 });
  });
});

const counts = { wait: 3, paused: 4, active: 2, prioritized: 1, delayed: 9, completed: 50, failed: 5, waitingChildren: 0 };
const sample = { name: 'emails', counts, isPaused: false, jobsTotal: 70, metricsCompleted: null, metricsFailed: null, events: { completed: 0, failed: 0, lastId: null, saturated: false } };
const rate = { completed: 12, failed: 1, intervalSeconds: 15, throughput: 48, failureRate: 4, failureRatio: 0.077, saturated: false };

describe('queueTickOf', () => {
  it('depth counts waiting, paused and prioritized jobs; finished jobs come from the rate point', () => {
    expect(queueTickOf(sample, rate, 2)).toEqual({ waiting: 8, active: 2, completed: 12, failed: 1, workers: 2 });
  });

  it('a seeding tick (no rate point) measured no finished jobs — null, not 0', () => {
    expect(queueTickOf(sample, null, null)).toEqual({ waiting: 8, active: 2, completed: null, failed: null, workers: null });
  });
});

describe('foldQueueTick — one row per bucket, written after it ends', () => {
  const tick = (over: Partial<QueueTick>): QueueTick => ({ waiting: 0, active: 0, completed: null, failed: null, workers: null, ...over });

  it('keeps peaks and sums within a bucket, closes it on the first tick of the next', () => {
    let r = foldQueueTick(undefined, at(0, 10), tick({ waiting: 40, active: 1, completed: null, workers: 1 }));
    expect(r.closed).toBeNull();
    r = foldQueueTick(r.open, at(2), tick({ waiting: 900, active: 3, completed: 7, failed: 1, workers: 3 }));
    r = foldQueueTick(r.open, at(4, 50), tick({ waiting: 120, active: 2, completed: 5, failed: null, workers: 2 }));
    expect(r.closed).toBeNull();
    r = foldQueueTick(r.open, at(5, 5), tick({ waiting: 10, completed: 2 }));
    expect(r.closed).toEqual({ bucket: T0, waiting: 900, active: 3, workers: 3, completed: 12, failed: 1 });
    expect(r.open).toEqual({ bucket: at(5), waiting: 10, active: 0, workers: null, completed: 2, failed: null });
  });

  it('a gap of several buckets closes the old one as it was', () => {
    const first = foldQueueTick(undefined, at(1), tick({ waiting: 5, completed: 3 }));
    const r = foldQueueTick(first.open, at(31), tick({ waiting: 6 }));
    expect(r.closed).toEqual({ bucket: T0, waiting: 5, active: 0, workers: null, completed: 3, failed: null });
    expect(r.open.bucket).toBe(at(30));
  });
});

describe('workersByQueue', () => {
  const view = (over: Partial<QueueView>): QueueView =>
    ({ name: 'emails', convention: 'bullmq', cacheStack: 'shop', cacheName: 'jobs', workers: { desired: 2, running: 2 }, ...over }) as QueueView;

  it('sums running copies of every BullMQ worker on the same cache + queue; raw lists are not counted', () => {
    const m = workersByQueue([
      view({}),
      view({ workers: { desired: 1, running: 1 } }),
      view({ name: 'images' }),
      view({ convention: 'list', name: 'outbox' }),
      view({ cacheStack: 'other' }),
    ]);
    expect(Object.fromEntries(m)).toEqual({ 'shop/jobs/emails': 3, 'shop/jobs/images': 2, 'other/jobs/emails': 2 });
  });
});
