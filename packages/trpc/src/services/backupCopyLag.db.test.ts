import { describe, expect, it } from 'bun:test';
import type { DbBackupCopyView } from '@swarmy/core';
import { foldDbCopies } from './backupCopyLag.db';
import type { BackupCopyLagView } from './backupCopyLag.service';

/** `backups.copyLag` covers DB schedules: each copying cluster counts at its second destination. */

const copy = (over: Partial<DbBackupCopyView> = {}): DbBackupCopyView => ({
  targetId: 'b2', targetName: null, method: 'dump', behindMs: 0, neverCopied: false, copying: false,
  failing: false, lastError: null, newestCopyAt: '2026-10-27T03:01:00.000Z', sizeBytes: '1000', restoresTo: null, ...over,
});
const VOL: BackupCopyLagView = {
  targetId: 'b2', schedules: 2, databases: 0, behindMs: 4 * 60_000, worstVolume: 'shop_uploads', neverCopied: 0,
  copying: 0, failing: 0, lastError: null, newestCopyAt: '2026-10-27T03:05:00.000Z', copiedBytes: '500',
};

describe('foldDbCopies', () => {
  it('adds the clusters to their destination; the worst lag wins and is named', () => {
    const [v] = foldDbCopies([VOL], [
      { ref: 'shop/main', copy: copy({ behindMs: 26 * 3_600_000, failing: true, lastError: 'AccessDenied' }) },
      { ref: 'shop/reports', copy: copy({ copying: true }) },
    ]);
    expect(v).toEqual({
      ...VOL, schedules: 4, databases: 2, behindMs: 26 * 3_600_000, worstVolume: 'shop/main', copying: 1,
      failing: 1, lastError: 'AccessDenied', copiedBytes: '2500',
    });
  });

  it('a destination only databases copy to gets its own row; the volume rows are left alone', () => {
    const out = foldDbCopies([VOL], [{ ref: 'shop/main', copy: copy({ targetId: 'r2', behindMs: null, neverCopied: true, newestCopyAt: null, sizeBytes: null }) }]);
    expect(out).toEqual([
      VOL,
      { targetId: 'r2', schedules: 1, databases: 1, behindMs: null, worstVolume: null, neverCopied: 1, copying: 0, failing: 0, lastError: null, newestCopyAt: null, copiedBytes: '0' },
    ]);
  });
});
