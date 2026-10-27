import { describe, expect, it } from 'bun:test';
import type { DbBackupCopyView } from '@swarmy/core';
import { isOffsite, pgCopyLine, pgCopyMethod } from './pg-copy-words';

const copy = (over: Partial<DbBackupCopyView> = {}): DbBackupCopyView => ({
  targetId: 'r2', targetName: 'R2', method: 'dump', behindMs: 4 * 60_000, neverCopied: false, copying: false,
  failing: false, lastError: null, newestCopyAt: '2026-10-27T03:01:00.000Z', sizeBytes: '268435456', restoresTo: null, ...over,
});

describe('pgCopyLine', () => {
  it('how far behind, off-site or not, with how and when at Controls', () => {
    expect(pgCopyLine(copy(), true)).toEqual({
      say: 'Off-site copy · 4 min behind',
      tone: 'ok',
      tech: 'a second dump after each save · newest copy 2026-10-27 03:01 UTC · 256.0 MB',
    });
    expect(pgCopyLine(copy({ behindMs: 0 }), false).say).toBe('Second copy · up to date');
    expect(pgCopyLine(copy({ behindMs: 0, copying: true }), true).say).toBe('Off-site copy · up to date · copying now');
  });

  it('a missed nightly copy warns; a failed one is bad and says why; never copied is said so', () => {
    expect(pgCopyLine(copy({ behindMs: 30 * 3_600_000 }), true)).toMatchObject({ say: 'Off-site copy · 30 h behind', tone: 'warn' });
    const failed = pgCopyLine(copy({ failing: true, lastError: 'AccessDenied' }), true);
    expect(failed).toMatchObject({ say: 'Off-site copy · the last copy failed', tone: 'bad' });
    expect(failed.tech).toContain('last error: AccessDenied');
    expect(pgCopyLine(copy({ neverCopied: true, behindMs: null }), true)).toMatchObject({ say: 'Off-site copy · not copied yet', tone: 'warn' });
    expect(pgCopyLine(copy({ behindMs: null, copying: true }), true)).toMatchObject({ say: 'Off-site copy · copying now', tone: 'idle' });
  });

  it('a point-in-time copy says how far a restore from it reaches', () => {
    const v = pgCopyLine(copy({ method: 'walg-copy', behindMs: 50 * 60_000, restoresTo: '2026-10-27T09:10:00.000Z', sizeBytes: null }), true);
    expect(v).toMatchObject({ say: 'Off-site copy · restores to 2026-10-27 09:10 UTC, 50 min behind', tone: 'ok' });
    expect(v.tech).toBe('wal-g copy after each base backup · newest copy 2026-10-27 03:01 UTC');
  });
});

describe('isOffsite / pgCopyMethod', () => {
  it('an S3 bucket outside swarmy’s own store is off-site', () => {
    expect(isOffsite({ kind: 'S3', name: 'Backblaze B2' })).toBe(true);
    expect(isOffsite({ kind: 's3', name: 'swarmy-object-storage' })).toBe(false);
    expect(isOffsite({ kind: 'node', name: 'NVMe' })).toBe(false);
  });

  it('logical engines copy by a second dump; pgBackRest can’t be copied', () => {
    expect(pgCopyMethod('pg_dump')).toBe('dump');
    expect(pgCopyMethod('pgbackrest')).toBeNull();
  });
});
