import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { BucketsOverview } from '@swarmy/core';
import { createTestDb, type TestDb } from '@swarmy/db';
import type { OrgContext } from '../context';
import { pruneDataHistory, recordBucketHistory, recordCacheHistory, recordQueueHistory, resetDataHistorySampler } from './data-history-record';
import type { SampledCluster } from './queue-studio.service';

const T0 = Date.UTC(2026, 9, 24, 12, 0, 0);
const at = (minutes: number): number => T0 + minutes * 60_000;

/** The worker consuming shop/jobs `emails`, two copies running. */
const worker = {
  id: 'svc-worker',
  name: 'shop_worker',
  image: 'shop/worker:1',
  mode: 'replicated',
  replicas: 2,
  desiredReplicas: 2,
  runningReplicas: 2,
  labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.queues': JSON.stringify([{ name: 'emails', cacheCluster: 'jobs' }]) },
  networks: [],
  env: [],
  ports: [],
  createdAt: 0,
  updatedAt: 0,
};

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
  resetDataHistorySampler();
});
afterEach(async () => {
  await t.close();
});

const ctx = (orgId = 'org'): OrgContext =>
  ({ activeOrgId: orgId, telemetry: t.telemetry, hub: { liveInventory: () => ({ services: [worker], containers: [] }) } }) as unknown as OrgContext;

describe('recordCacheHistory', () => {
  const c = { stack: 'shop', cluster: 'main', hits: 900, misses: 100, opsPerSec: 40, usedMemoryBytes: 1024 };

  it('writes the first reading of each bucket, and only that one', async () => {
    expect(await recordCacheHistory(ctx(), c, at(1))).toBe(true);
    expect(await recordCacheHistory(ctx(), { ...c, hits: 950 }, at(3))).toBe(false);
    expect(await recordCacheHistory(ctx(), { ...c, hits: 990 }, at(6))).toBe(true);
    const rows = await t.telemetry.cacheStatSample.findMany({ orderBy: { bucketStart: 'asc' } });
    expect(rows.map((r) => [r.bucketStart.getTime(), Number(r.hits)])).toEqual([
      [T0, 900],
      [at(5), 990],
    ]);
  });

  it('a restart inside a bucket never doubles it (the first reading stays)', async () => {
    await recordCacheHistory(ctx(), c, at(1));
    resetDataHistorySampler();
    expect(await recordCacheHistory(ctx(), { ...c, hits: 999 }, at(2))).toBe(true);
    const rows = await t.telemetry.cacheStatSample.findMany();
    expect(rows.map((r) => Number(r.hits))).toEqual([900]);
  });
});

const sampled = (waiting: number, completed: number | null): SampledCluster[] => [
  {
    stack: 'shop',
    cluster: 'jobs',
    prefix: 'bull',
    queues: [
      {
        name: 'emails',
        counts: { wait: waiting, paused: 0, active: 1, prioritized: 0, delayed: 0, completed: 0, failed: 0, waitingChildren: 0 },
        isPaused: false,
        jobsTotal: 0,
        metricsCompleted: null,
        metricsFailed: null,
        events: { completed: 0, failed: 0, lastId: '1-0', saturated: false },
      },
    ],
    rates: { emails: completed === null ? null : { completed, failed: 0, intervalSeconds: 15, throughput: 0, failureRate: 0, failureRatio: 0, saturated: false } },
  },
];

describe('recordQueueHistory', () => {
  it('writes a bucket once it ends: peak depth, the jobs finished in it, worker copies', async () => {
    expect(await recordQueueHistory(ctx(), sampled(10, null), at(0))).toBe(0);
    expect(await recordQueueHistory(ctx(), sampled(80, 7), at(2))).toBe(0);
    expect(await recordQueueHistory(ctx(), sampled(30, 5), at(4))).toBe(0);
    expect(await t.telemetry.queueStatSample.count()).toBe(0);
    expect(await recordQueueHistory(ctx(), sampled(5, 1), at(5))).toBe(1);
    const [row] = await t.telemetry.queueStatSample.findMany();
    expect(row).toMatchObject({ orgId: 'org', stack: 'shop', cluster: 'jobs', prefix: 'bull', queue: 'emails', waiting: 80, active: 1, completed: 12, failed: 0, workers: 2 });
    expect(row!.bucketStart.getTime()).toBe(T0);
  });

  it('a queue that stops being sampled still gets its last bucket written', async () => {
    await recordQueueHistory(ctx(), sampled(10, 3), at(1));
    expect(await recordQueueHistory(ctx(), [], at(6))).toBe(1);
    expect(await recordQueueHistory(ctx(), [], at(11))).toBe(0);
    expect(await t.telemetry.queueStatSample.count()).toBe(1);
  });
});

describe('recordBucketHistory', () => {
  const ov = (usageBytes: number): BucketsOverview => ({
    state: 'ready',
    endpoint: 'http://swarmy-garage:3900',
    region: 'swarmy',
    buckets: [{ id: 'b1', name: 'media', usageBytes, objects: 12, unfinishedUploads: 0, website: false, quotas: { maxSizeBytes: null, maxObjects: null }, keyCount: 1 }],
  });

  it('reads the store once per bucket, and an unreachable store is not asked again until the next one', async () => {
    let reads = 0;
    const read = async (): Promise<BucketsOverview> => (++reads === 1 ? { state: 'unreachable', endpoint: null, region: 'swarmy', buckets: [] } : ov(2048));
    expect(await recordBucketHistory(ctx(), at(1), read)).toBe(0);
    expect(await recordBucketHistory(ctx(), at(2), read)).toBe(0);
    expect(reads).toBe(1);
    expect(await recordBucketHistory(ctx(), at(5), read)).toBe(1);
    const [row] = await t.telemetry.bucketStatSample.findMany();
    expect([row!.bucketId, Number(row!.bytes), row!.objects, row!.bucketStart.getTime()]).toEqual(['b1', 2048, 12, at(5)]);
  });
});

describe('pruneDataHistory', () => {
  it('drops rows older than 7 days from all three tables, keeps the rest', async () => {
    const old = new Date(at(0) - 8 * 86_400_000);
    const recent = new Date(at(0) - 6 * 86_400_000);
    for (const bucketStart of [old, recent]) {
      await t.telemetry.cacheStatSample.create({ data: { orgId: 'o', stack: 's', cluster: 'c', bucketStart, hits: 1n, misses: 1n, opsPerSec: 1, usedMemoryBytes: 1n } });
      await t.telemetry.queueStatSample.create({ data: { orgId: 'o', stack: 's', cluster: 'c', prefix: 'bull', queue: 'q', bucketStart, waiting: 1, active: 0 } });
      await t.telemetry.bucketStatSample.create({ data: { orgId: 'o', bucketId: 'b', bucketStart, bytes: 1n, objects: 1 } });
    }
    expect(await pruneDataHistory(t.telemetry, at(0))).toBe(3);
    expect(await t.telemetry.cacheStatSample.count()).toBe(1);
    expect(await t.telemetry.queueStatSample.count()).toBe(1);
    expect(await t.telemetry.bucketStatSample.count()).toBe(1);
  });
});
