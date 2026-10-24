import { describe, expect, it } from 'bun:test';
import { FAILOVER_WATERMARK_MAX_GAP_MS, decideFailover } from '@swarmy/core';
import {
  RESTORED_WATERMARK_MAX_AGE_MS,
  WATERMARK_RUN_KIND,
  forgetWatermark,
  parsePersistedWatermarks,
  recordWatermark,
  restoreWatermark,
} from './manageddb-watermark.core';
import { createWatermarkStore } from './manageddb-watermark';

/**
 * The failover watermark across controller restarts. The invariant defended:
 * "Failover never silently loses data" — a stored sample only stands in when
 * it is as fresh as the in-memory path demands; anything else stays unknown ⇒
 * hold.
 */

const T = 1_700_000_000_000;
const SAMPLE = { primary: 'shop_pg-primary', lsn: '0/3000', sampledAt: T };

describe('restoreWatermark — the in-memory envelope, measured to the first unhealthy sight', () => {
  it('the envelope equals the in-memory freshness gap plus one tick', () => {
    expect(RESTORED_WATERMARK_MAX_AGE_MS).toBe(FAILOVER_WATERMARK_MAX_GAP_MS + 15_000);
  });

  it('a quick restart: the sample stands in, last healthy = the sample', () => {
    expect(restoreWatermark(SAMPLE, { primary: 'shop_pg-primary', firstUnhealthyAt: T + 30_000 })).toEqual({
      watermark: { lsn: '0/3000', sampledAt: T },
      lastHealthyAt: T,
    });
  });

  it('a long controller outage, another primary, nothing stored or a clock going backwards ⇒ null (hold)', () => {
    expect(restoreWatermark(SAMPLE, { primary: 'shop_pg-primary', firstUnhealthyAt: T + RESTORED_WATERMARK_MAX_AGE_MS + 1 })).toBeNull();
    expect(restoreWatermark(SAMPLE, { primary: 'shop_pg-replica', firstUnhealthyAt: T + 1_000 })).toBeNull();
    expect(restoreWatermark(SAMPLE, { primary: undefined, firstUnhealthyAt: T + 1_000 })).toBeNull();
    expect(restoreWatermark(undefined, { primary: 'shop_pg-primary', firstUnhealthyAt: T + 1_000 })).toBeNull();
    expect(restoreWatermark(SAMPLE, { primary: 'shop_pg-primary', firstUnhealthyAt: T - 1 })).toBeNull();
  });

  it('end to end with decideFailover: restored ⇒ provable promote; unknown ⇒ confirm (hold)', () => {
    const candidates = [{ service: 'shop_pg-replica', running: 1, replayLsn: '0/3000', lagSeconds: 0 }];
    const restored = restoreWatermark(SAMPLE, { primary: 'shop_pg-primary', firstUnhealthyAt: T + 20_000 })!;
    const go = decideFailover({ topology: 'failover', candidates, confirmation: null, ...restored });
    expect(go).toMatchObject({ kind: 'promote', target: 'shop_pg-replica', behindBytes: 0, confirmed: false });
    const held = decideFailover({ topology: 'failover', candidates, confirmation: null, watermark: null, lastHealthyAt: null });
    expect(held.kind).toBe('confirm');
    // A replica one byte short of a restored watermark still holds.
    const behind = decideFailover({ topology: 'failover', candidates: [{ ...candidates[0]!, replayLsn: '0/2FFF' }], confirmation: null, ...restored });
    expect(behind).toMatchObject({ kind: 'confirm', behindBytes: 1 });
  });
});

describe('stored map codec', () => {
  it('drops malformed entries instead of trusting them', () => {
    expect(
      parsePersistedWatermarks({
        'shop/pg': SAMPLE,
        'shop/bad-lsn': { ...SAMPLE, lsn: 'garbage' },
        'shop/no-primary': { ...SAMPLE, primary: '' },
        'shop/no-time': { primary: 'p', lsn: '0/1' },
      }),
    ).toEqual({ 'shop/pg': SAMPLE });
    expect(parsePersistedWatermarks(null)).toEqual({});
    expect(parsePersistedWatermarks([SAMPLE])).toEqual({});
  });

  it('record replaces the cluster, prunes entries too old to restore; forget drops it', () => {
    const old = { ...SAMPLE, sampledAt: T - 11 * 60_000 };
    const next = recordWatermark({ 'shop/old': old, 'shop/other': SAMPLE }, 'shop/pg', { ...SAMPLE, sampledAt: T + 15_000 });
    expect(Object.keys(next).sort()).toEqual(['shop/other', 'shop/pg']);
    expect(next['shop/pg']!.sampledAt).toBe(T + 15_000);
    expect(forgetWatermark(next, 'shop/pg')).toEqual({ 'shop/other': SAMPLE });
    const same = { 'shop/x': SAMPLE };
    expect(forgetWatermark(same, 'shop/none')).toBe(same);
  });
});

/** An in-memory `operationRun` delegate (the controller store, minus SQL). */
function fakeDb(initial?: unknown, opts: { failRead?: boolean } = {}) {
  const rows = new Map<string, unknown>();
  if (initial !== undefined) rows.set(`org1/${WATERMARK_RUN_KIND}`, initial);
  let writes = 0;
  const operationRun = {
    findUnique: async ({ where }: { where: { orgId_kind: { orgId: string; kind: string } } }) => {
      if (opts.failRead) throw new Error('db down');
      const k = `${where.orgId_kind.orgId}/${where.orgId_kind.kind}`;
      return rows.has(k) ? { run: rows.get(k) } : null;
    },
    upsert: async ({ where, update }: { where: { orgId_kind: { orgId: string; kind: string } }; update: { run: unknown } }) => {
      writes++;
      rows.set(`${where.orgId_kind.orgId}/${where.orgId_kind.kind}`, JSON.parse(JSON.stringify(update.run)));
      return {};
    },
  };
  return { db: { operationRun } as never, rows, writes: () => writes };
}

describe('createWatermarkStore — load on boot, record, flush once per change', () => {
  it('a restarted controller loads what the previous one stored', async () => {
    const before = fakeDb();
    const a = createWatermarkStore(before.db);
    await a.load('org1');
    a.record('org1', 'shop/pg', SAMPLE);
    await a.flush('org1');
    const b = createWatermarkStore(fakeDb(before.rows.get(`org1/${WATERMARK_RUN_KIND}`)).db);
    await b.load('org1');
    expect(b.get('org1', 'shop/pg')).toEqual(SAMPLE);
  });

  it('nothing stored, or the store unreadable ⇒ no sample (unknown ⇒ hold)', async () => {
    const empty = createWatermarkStore(fakeDb().db);
    await empty.load('org1');
    expect(empty.get('org1', 'shop/pg')).toBeUndefined();
    const broken = createWatermarkStore(fakeDb({ 'shop/pg': SAMPLE }, { failRead: true }).db);
    await broken.load('org1');
    expect(broken.get('org1', 'shop/pg')).toBeUndefined();
  });

  it('flush writes only after a change; forget is persisted', async () => {
    const f = fakeDb({ 'shop/pg': SAMPLE });
    const s = createWatermarkStore(f.db);
    await s.load('org1');
    await s.flush('org1');
    expect(f.writes()).toBe(0);
    s.forget('org1', 'shop/pg');
    s.forget('org1', 'shop/none');
    await s.flush('org1');
    await s.flush('org1');
    expect(f.writes()).toBe(1);
    expect(f.rows.get(`org1/${WATERMARK_RUN_KIND}`)).toEqual({});
  });
});
