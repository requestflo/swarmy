import { describe, expect, it } from 'bun:test';
import { copyMethod, nextCopyRecord, parseCopyLabel, type DbBackupCopyRecord } from './dbBackupCopy.label';
import { dbCopyView, type DbCopyViewInput } from './dbBackupCopy.view';

/**
 * "Also copy to" for DB schedules: the `swarmy.db.backup.copy` label keeps
 * the last attempt and the newest copy that landed, and the lag is read off
 * the labels: the newest save against when the newest landed copy began. A
 * copy in flight is not lag; never copied and failing are said apart.
 */

const T = (min: number) => new Date(Date.parse('2026-10-27T03:00:00Z') + min * 60_000).toISOString();
const SCHED = { engine: 'pg_dump' as const, targetId: 'garage', secondaryTargetId: 'b2' };
const ok = (savedMin: number, startMin: number): DbBackupCopyRecord =>
  nextCopyRecord(null, { targetId: 'b2', savedAt: T(savedMin), startedAt: T(startMin), status: 'succeeded', snapshotId: 'c1', sizeBytes: '2048' });
const view = (over: Partial<DbCopyViewInput>) =>
  dbCopyView({ schedule: SCHED, lastRun: { at: T(0), status: 'succeeded' }, record: null, copying: false, targetName: 'B2', mainReachesTo: Date.parse(T(0)), ...over });

describe('the copy label', () => {
  it('round-trips, and a failure keeps the last copy that landed there', () => {
    const first = ok(0, 1);
    expect(parseCopyLabel(JSON.stringify(first))).toEqual(first);
    const failed = nextCopyRecord(first, { targetId: 'b2', savedAt: T(1440), startedAt: T(1441), status: 'failed', error: 'AccessDenied' });
    expect(failed).toEqual({ targetId: 'b2', savedAt: T(1440), startedAt: T(1441), status: 'failed', error: 'AccessDenied', ok: first.ok });
    // A record about another destination carries nothing over.
    expect(nextCopyRecord(first, { targetId: 'r2', savedAt: T(9), startedAt: T(9), status: 'failed', error: 'x' }).ok).toBeUndefined();
  });

  it('malformed or foreign JSON is no record', () => {
    for (const raw of [undefined, '', 'nope', '{}', JSON.stringify({ targetId: 'b2', savedAt: 'x', startedAt: T(0), status: 'succeeded' })]) {
      expect(parseCopyLabel(raw)).toBeNull();
    }
  });

  it('logical engines copy by a second dump; pgBackRest keeps one repo', () => {
    expect(['pg_dump', 'pg_dumpall', 'snapshot-from-replica'].map((e) => copyMethod(e as never))).toEqual(['dump', 'dump', 'dump']);
    expect(copyMethod('pgbackrest')).toBeNull();
  });
});

describe('dbCopyView', () => {
  it('in step when the copy began after the save', () => {
    expect(view({ record: ok(0, 1) })).toEqual({
      targetId: 'b2', targetName: 'B2', method: 'dump', behindMs: 0, neverCopied: false, copying: false,
      failing: false, lastError: null, newestCopyAt: T(1), sizeBytes: '2048', restoresTo: null,
    });
  });

  it('a failed copy leaves it behind the newest save by the gap to the last good copy', () => {
    const failed = nextCopyRecord(ok(-1440, -1439), { targetId: 'b2', savedAt: T(0), startedAt: T(1), status: 'failed', error: 'AccessDenied' });
    expect(view({ record: failed })).toMatchObject({ behindMs: 1439 * 60_000, failing: true, lastError: 'AccessDenied' });
    // After a failed save too, the newest good save is the one the last attempt copied.
    expect(view({ record: failed, lastRun: { at: T(1440), status: 'failed' } })).toMatchObject({ behindMs: 1439 * 60_000 });
  });

  it('a copy in flight is not lag; a save never copied is said so', () => {
    expect(view({ record: ok(-1440, -1439), copying: true })).toMatchObject({ behindMs: 0, copying: true, failing: false });
    expect(view({})).toMatchObject({ behindMs: null, neverCopied: true });
    expect(view({ lastRun: null })).toMatchObject({ behindMs: null, neverCopied: false });
    // A copy record about a former second destination says nothing about this one.
    expect(view({ record: { ...ok(0, 1), targetId: 'r2' } })).toMatchObject({ neverCopied: true, newestCopyAt: null });
  });

  it('no copy without a second destination, the same one twice, or an engine that can’t copy', () => {
    expect(view({ schedule: { ...SCHED, secondaryTargetId: undefined } })).toBeNull();
    expect(view({ schedule: { ...SCHED, secondaryTargetId: 'garage' } })).toBeNull();
    expect(view({ schedule: { ...SCHED, engine: 'pgbackrest' } })).toBeNull();
    expect(view({ schedule: null })).toBeNull();
  });
});
