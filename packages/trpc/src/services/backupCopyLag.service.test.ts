import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createTestDb, type TestDb } from '@swarmy/db';
import type { OrgContext } from '../context';
import { copyLag, getCopyLag, type SnapRow } from './backupCopyLag.service';
import { seedKvRows } from './swarm-kv.service';

/**
 * The "also copy to" destination's lag, from the catalogue alone: per
 * volume the newest save on the primary destination against the newest copy
 * on the second one. A copy in flight is not lag, a copy that never landed
 * and one that failed are counted apart, and the worst volume is named.
 */

const T0 = Date.parse('2026-10-25T03:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000);
const row = (volume: string, targetId: string, min: number, status = 'SUCCEEDED', extra: Partial<SnapRow> = {}): SnapRow => ({
  volume, targetId, status, startedAt: at(min), sizeBytes: 1000, error: null, ...extra,
});
const SCHEDULES = [
  { volume: 'shop_db', targetId: 'garage', secondaryTargetId: 'b2' },
  { volume: 'shop_uploads', targetId: 'garage', secondaryTargetId: 'b2' },
  { volume: 'shop_cache', targetId: 'garage', secondaryTargetId: null },
];

describe('copyLag', () => {
  it('in step when each copy started after its save; the copy sizes add up', () => {
    const v = copyLag(SCHEDULES, [row('shop_db', 'garage', 0), row('shop_db', 'b2', 3), row('shop_uploads', 'garage', 1), row('shop_uploads', 'b2', 5, 'SUCCEEDED', { sizeBytes: 500 })]);
    expect(v).toEqual([
      { targetId: 'b2', schedules: 2, databases: 0, behindMs: 0, worstVolume: 'shop_db', neverCopied: 0, copying: 0, failing: 0, lastError: null, newestCopyAt: at(5).toISOString(), copiedBytes: '1500' },
    ]);
  });

  it('a failed copy leaves it behind by the gap between the newest save and the last good copy', () => {
    const [v] = copyLag(SCHEDULES, [
      row('shop_db', 'garage', 0),
      row('shop_db', 'b2', -24 * 60 + 3),
      row('shop_db', 'b2', 2, 'FAILED', { error: 'AccessDenied' }),
      row('shop_uploads', 'garage', 0),
      row('shop_uploads', 'b2', 2),
    ]);
    expect(v).toMatchObject({ behindMs: (24 * 60 - 3) * 60_000, worstVolume: 'shop_db', failing: 1, lastError: 'AccessDenied' });
  });

  it('a copy running now is not lag; a volume never copied is counted; nothing saved yet is no lag at all', () => {
    const [running] = copyLag(SCHEDULES, [row('shop_db', 'garage', 0), row('shop_db', 'b2', -24 * 60), row('shop_db', 'b2', 1, 'RUNNING'), row('shop_uploads', 'garage', 0)]);
    expect(running).toMatchObject({ behindMs: 0, copying: 1, neverCopied: 1 });
    const [empty] = copyLag(SCHEDULES, []);
    expect(empty).toMatchObject({ schedules: 2, behindMs: null, neverCopied: 0, newestCopyAt: null, copiedBytes: '0' });
  });

  it('no second destination, or the same one twice, is no copy', () => {
    expect(copyLag([{ volume: 'v', targetId: 'a', secondaryTargetId: 'a' }, { volume: 'w', targetId: 'a' }], [])).toEqual([]);
  });
});

describe('getCopyLag over the controller store', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  it('reads the newest rows per volume and destination, active schedules only', async () => {
    const orgId = 'org-copylag';
    await t.db.organization.create({ data: { id: orgId, name: orgId, slug: orgId, createdAt: new Date() } });
    const hub = { managerNode: () => 'n1' };
    seedKvRows(hub as never, orgId, 'bkp-sched', [
      { id: 's1', targetId: 'garage', secondaryTargetId: 'b2', volume: 'shop_db', nodeId: null, every: 1, unit: 'days', paused: false, auto: false, retentionDays: null, anchorAt: null, optedOutAt: null },
      { id: 's2', targetId: 'garage', secondaryTargetId: 'b2', volume: 'shop_old', nodeId: null, every: 1, unit: 'days', paused: true, auto: false, retentionDays: null, anchorAt: null, optedOutAt: null },
    ]);
    const snap = (targetId: string, min: number, status: 'SUCCEEDED' | 'FAILED' | 'RUNNING') =>
      t.db.snapshot.create({ data: { orgId, targetId, volume: 'shop_db', status, startedAt: at(min), sizeBytes: 2048n } });
    await snap('garage', -24 * 60, 'SUCCEEDED');
    await snap('b2', -24 * 60 + 2, 'SUCCEEDED');
    await snap('garage', 0, 'SUCCEEDED');
    await snap('b2', 2, 'FAILED');
    const ctx = { db: t.db, hub, activeOrgId: orgId } as unknown as OrgContext;
    const [v] = await getCopyLag(ctx, T0 + 60_000);
    expect(v).toMatchObject({ targetId: 'b2', schedules: 1, behindMs: (24 * 60 - 2) * 60_000, failing: 1, copiedBytes: '2048' });
  });
});
