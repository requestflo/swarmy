import { describe, expect, it } from 'bun:test';
import { BackupVolumePayload, BackupVolumeResult, RetentionOutcome } from './backup';
import { DbBackupPayload, DbBackupResult } from './dbBackup';

const repo = { kind: 's3' as const, repo: 's3:https://s3.example.com/b/p', password: 'pw' };

describe('retentionDays payload field (additive, optional)', () => {
  it('BackupVolumePayload accepts and round-trips retentionDays', () => {
    const p = BackupVolumePayload.parse({
      commandId: '00000000-0000-4000-8000-000000000001',
      jobId: 'j1',
      repo,
      volume: 'shop_db-data',
      tags: ['org:o1', 'volume:shop_db-data'],
      retentionDays: 30,
    });
    expect(p.retentionDays).toBe(30);
    expect(BackupVolumePayload.parse(p)).toEqual(p);
  });

  it('stays optional — older controllers omit it and parse still succeeds', () => {
    const p = BackupVolumePayload.parse({ commandId: '00000000-0000-4000-8000-000000000001', jobId: 'j1', repo, volume: 'v' });
    expect(p.retentionDays).toBeUndefined();
  });

  it('rejects out-of-range windows', () => {
    const base = { commandId: '00000000-0000-4000-8000-000000000001', jobId: 'j1', repo, volume: 'v' };
    expect(BackupVolumePayload.safeParse({ ...base, retentionDays: 0 }).success).toBe(false);
    expect(BackupVolumePayload.safeParse({ ...base, retentionDays: 3651 }).success).toBe(false);
    expect(BackupVolumePayload.safeParse({ ...base, retentionDays: 1.5 }).success).toBe(false);
  });

  it('DbBackupPayload accepts retentionDays alongside the engine knobs', () => {
    const p = DbBackupPayload.parse({
      commandId: '00000000-0000-4000-8000-000000000001',
      jobId: 'j1',
      engine: 'pg_dump',
      conn: { host: 'db', password: 'pw' },
      repo,
      tags: ['org:o1', 'db:shop/main'],
      retentionDays: 14,
    });
    expect(p.retentionDays).toBe(14);
  });
});

describe('retention result field (additive, optional)', () => {
  it('round-trips a successful prune outcome', () => {
    const r = BackupVolumeResult.parse({
      snapshotId: 'abc',
      sizeBytes: 10,
      retention: { retentionDays: 30, snapshotsRemoved: 2 },
    });
    expect(r.retention?.snapshotsRemoved).toBe(2);
    expect(r.retention?.error).toBeUndefined();
  });

  it('carries a retention error without failing the backup result parse', () => {
    const r = DbBackupResult.parse({
      snapshotId: 'abc',
      engine: 'pg_dump',
      retention: { retentionDays: 7, snapshotsRemoved: 0, error: 'repo locked' },
    });
    expect(r.retention?.error).toBe('repo locked');
  });

  it('results from older agents (no retention field) still parse', () => {
    expect(BackupVolumeResult.parse({ snapshotId: 'a', sizeBytes: 0 }).retention).toBeUndefined();
    expect(RetentionOutcome.safeParse({ retentionDays: 0, snapshotsRemoved: 0 }).success).toBe(false);
  });
});
