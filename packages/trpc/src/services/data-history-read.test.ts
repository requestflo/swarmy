import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createTestDb, type TestDb } from '@swarmy/db';
import type { OrgContext } from '../context';
import { bucketSizeHistory } from './bucket-history';
import { cacheStatsHistory } from './cache-history';
import { historyWindow, slotGrid } from './data-history-grid';
import { queueDepthHistory } from './queue-history';

/** cache.statsHistory / queues.depthHistory / buckets.sizeHistory over a real telemetry.db, org wall included. */

const NOW = Date.UTC(2026, 9, 24, 12, 2, 30);
const hm = (h: number, m: number): Date => new Date(Date.UTC(2026, 9, 24, h, m));

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});
const ctx = (orgId = 'org'): OrgContext => ({ activeOrgId: orgId, telemetry: t.telemetry }) as unknown as OrgContext;

describe('slotGrid', () => {
  it('ends on the slot holding now and drops rows outside the window', () => {
    const w = historyWindow(6, NOW);
    expect([w.step, w.slots]).toEqual([300, 72]);
    const first = w.from / 1000 / w.step;
    const g = slotGrid([{ slot: first, v: 1 }, { slot: BigInt(first + 71), v: 2n }, { slot: first + 72, v: 9 }, { slot: first - 1, v: 9 }], ['v'], w);
    expect([g.v[0], g.v[1], g.v[71]]).toEqual([1, null, 2]);
    expect(g.v.filter((x) => x !== null)).toEqual([1, 2]);
  });
});

describe('cache.statsHistory', () => {
  const row = (orgId: string, at: Date, hits: number, misses: number, ops = 10) =>
    t.telemetry.cacheStatSample.create({
      data: { orgId, stack: 'shop', cluster: 'main', bucketStart: at, hits: BigInt(hits), misses: BigInt(misses), opsPerSec: ops, usedMemoryBytes: 1000n },
    });

  it("a slot's hit rate is the share of that slot's lookups that hit; a restart skips its interval", async () => {
    await row('org', hm(11, 30), 1000, 100);
    await row('org', hm(11, 35), 1090, 110, 40); // +90 / +10
    await row('org', hm(11, 40), 1100, 150); //     +10 / +40
    await row('org', hm(11, 45), 5, 1); //          restarted: skipped
    await row('org', hm(11, 50), 25, 1); //         +20 / +0
    await row('org', hm(12, 0), 25, 1, 7); //       no lookups
    await row('other', hm(11, 35), 9_999_999, 0); // another org, same names
    const h = await cacheStatsHistory(ctx(), { stack: 'shop', cluster: 'main' }, NOW);
    expect([h.stepSeconds, h.hitRatePct.length]).toEqual([900, 96]);
    expect(h.hitRatePct.slice(-3)).toEqual([66.7, 100, null]);
    expect(h.lookups.slice(-3)).toEqual([150, 20, 0]);
    expect(h.opsPerSec.slice(-3)).toEqual([40, 10, 7]);
    expect(h.hitRatePct.filter((v) => v !== null)).toEqual([66.7, 100]);
  });

  it('diffs the first slot against the reading just before the window', async () => {
    const w = historyWindow(1, NOW);
    await row('org', new Date(w.from - 300_000), 100, 0);
    await row('org', new Date(w.from), 130, 10);
    const h = await cacheStatsHistory(ctx(), { stack: 'shop', cluster: 'main', hours: 1 }, NOW);
    expect(h.hitRatePct[0]).toBe(75);
  });

  it('the org wall: another org sees nothing', async () => {
    await row('org', hm(11, 30), 1, 1);
    await row('org', hm(11, 35), 2, 2);
    const h = await cacheStatsHistory(ctx('other'), { stack: 'shop', cluster: 'main' }, NOW);
    expect(h.lookups.every((v) => v === null)).toBe(true);
  });
});

describe('queues.depthHistory', () => {
  const row = (orgId: string, at: Date, waiting: number, completed: number | null, workers: number | null = 1, queue = 'emails') =>
    t.telemetry.queueStatSample.create({
      data: { orgId, stack: 'shop', cluster: 'jobs', prefix: 'bull', queue, bucketStart: at, waiting, active: 1, completed, failed: completed === null ? null : 0, workers },
    });

  it('6 h in 5-minute slots; 24 h folds peaks and sums into 15-minute slots', async () => {
    await row('org', hm(11, 45), 900, 12, 3);
    await row('org', hm(11, 50), 200, 30, 2);
    await row('org', hm(11, 55), 40, null, null);
    await row('org', hm(11, 50), 5000, 999, 9, 'images'); // another queue
    await row('other', hm(11, 50), 7000, 999, 9); //          another org
    const six = await queueDepthHistory(ctx(), { stack: 'shop', cluster: 'jobs', queue: 'emails' }, NOW);
    expect([six.stepSeconds, six.waiting.length]).toEqual([300, 72]);
    expect(six.waiting.slice(-4)).toEqual([900, 200, 40, null]);
    expect(six.workers.slice(-4)).toEqual([3, 2, null, null]);
    expect(six.completed.slice(-4)).toEqual([12, 30, null, null]);
    const day = await queueDepthHistory(ctx(), { stack: 'shop', cluster: 'jobs', queue: 'emails', hours: 24 }, NOW);
    expect(day.stepSeconds).toBe(900);
    expect([day.waiting.at(-2), day.workers.at(-2), day.completed.at(-2), day.failed.at(-2)]).toEqual([900, 3, 42, 0]);
  });

  it('the org wall: another org reads an empty grid for the same queue', async () => {
    await row('org', hm(11, 50), 200, 30);
    const h = await queueDepthHistory(ctx('other'), { stack: 'shop', cluster: 'jobs', queue: 'emails' }, NOW);
    expect(h.waiting.every((v) => v === null)).toBe(true);
  });
});

describe('buckets.sizeHistory', () => {
  const row = (orgId: string, at: Date, bytes: number, bucketId = 'b1') =>
    t.telemetry.bucketStatSample.create({ data: { orgId, bucketId, bucketStart: at, bytes: BigInt(bytes), objects: Math.round(bytes / 100) } });

  it('7 days in hourly slots, each holding its largest reading; org-scoped', async () => {
    await row('org', new Date(NOW - 6 * 86_400_000), 1_000);
    await row('org', hm(11, 5), 4_000);
    await row('org', hm(11, 55), 5_000);
    await row('org', hm(11, 55), 9_999_999, 'b2');
    await row('other', hm(11, 55), 9_999_999);
    const h = await bucketSizeHistory(ctx(), { bucketId: 'b1' }, NOW);
    expect([h.stepSeconds, h.bytes.length]).toEqual([3600, 168]);
    expect(h.bytes.at(-2)).toBe(5_000);
    expect(h.objects.at(-2)).toBe(50);
    expect(h.bytes.filter((v) => v !== null)).toEqual([1_000, 5_000]);
    const other = await bucketSizeHistory(ctx('other'), { bucketId: 'b1' }, NOW);
    expect(other.bytes.filter((v) => v !== null)).toEqual([9_999_999]);
  });
});
