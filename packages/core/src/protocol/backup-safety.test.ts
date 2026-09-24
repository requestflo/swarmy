import { describe, expect, it } from 'bun:test';
import { AppDbBackupPayload, AppDbRestorePayload, AppDbVerifyPayload } from './appDb';
import { BackupVolumeMsg, BackupVolumePayload, DockerVolumeName, RestoreVolumePayload } from './backup';
import { DbBackupPayload, DbRestorePayload } from './dbBackup';

// Invariant: no backup payload field can name a HOST path for a Docker bind
// (`/` would archive — or on restore, overwrite — the node's root), and no
// value that reaches a sidecar shell script can carry shell/SQL syntax.

const commandId = '00000000-0000-4000-8000-000000000001';
const repo = { kind: 's3' as const, repo: 's3:https://s3.example.com/b/p', password: 'pw' };
const creds = { scope: 'root' as const, port: 6379 };
const BAD_VOLUMES = ['/', '/etc', '../x', 'a:b', 'a:/data:rw', '', '-x', 'a/b'];

describe('DockerVolumeName', () => {
  it('accepts named volumes', () => {
    for (const v of ['swarmy-registry-data', 'shop_db-data', 'v', 'a.b']) expect(DockerVolumeName.parse(v)).toBe(v);
  });
  it('rejects host paths, traversal and bind options', () => {
    for (const v of BAD_VOLUMES) expect(DockerVolumeName.safeParse(v).success).toBe(false);
  });
});

describe('volume fields on every backup/restore payload', () => {
  it('backupVolume.volume', () => {
    const ok = BackupVolumePayload.parse({ commandId, jobId: 'j', repo, volume: 'swarmy-registry-data' });
    expect(BackupVolumeMsg.parse({ type: 'backupVolume', payload: ok }).payload.volume).toBe('swarmy-registry-data');
    for (const v of BAD_VOLUMES) expect(BackupVolumePayload.safeParse({ commandId, jobId: 'j', repo, volume: v }).success).toBe(false);
  });
  it('restoreVolume.targetVolume + snapshotId', () => {
    expect(RestoreVolumePayload.parse({ commandId, repo, targetVolume: 'v1' }).snapshotId).toBe('latest');
    for (const v of BAD_VOLUMES) expect(RestoreVolumePayload.safeParse({ commandId, repo, targetVolume: v }).success).toBe(false);
    expect(RestoreVolumePayload.safeParse({ commandId, repo, targetVolume: 'v1', snapshotId: '--help' }).success).toBe(false);
  });
  it('db dataVolume', () => {
    const base = { commandId, jobId: 'j', engine: 'wal-g', conn: { host: 'db', password: 'pw' }, repo };
    expect(DbBackupPayload.parse({ ...base, dataVolume: 'shop_main-data' }).dataVolume).toBe('shop_main-data');
    expect(DbBackupPayload.safeParse({ ...base, dataVolume: '/' }).success).toBe(false);
  });
  it('appDb dataVolume / dataMount / copyVolume / snapshotId', () => {
    const base = { commandId, jobId: 'j', engine: 'redis', service: 's_redis', creds, repo, host: 'h' };
    expect(AppDbBackupPayload.parse({ ...base, dataVolume: 'redis-data', dataMount: '/data' }).dataMount).toBe('/data');
    expect(AppDbBackupPayload.safeParse({ ...base, dataVolume: '/' }).success).toBe(false);
    expect(AppDbBackupPayload.safeParse({ ...base, dataVolume: 'v', dataMount: '/data:rw' }).success).toBe(false);
    expect(AppDbBackupPayload.safeParse({ ...base, dataVolume: 'v', dataMount: '/../etc' }).success).toBe(false);
    const r = { commandId, engine: 'redis', mode: 'copy', service: 's', creds, repo, snapshotId: 'abc123', suffix: 'copy1' };
    expect(AppDbRestorePayload.parse({ ...r, copyVolume: 'redis-data_copy1' }).copyVolume).toBe('redis-data_copy1');
    expect(AppDbRestorePayload.safeParse({ ...r, copyVolume: '/' }).success).toBe(false);
    expect(AppDbRestorePayload.safeParse({ ...r, snapshotId: '$(id)' }).success).toBe(false);
    const v = { commandId, engine: 'redis', image: 'redis:7', repo, snapshotId: 'abc' };
    expect(AppDbVerifyPayload.safeParse({ ...v, dataMount: 'data' }).success).toBe(false);
  });
});

describe('dbRestore shell-bound fields', () => {
  const base = { commandId, engine: 'wal-g', mode: 'pitr', conn: { host: 'db', password: 'pw' }, repo };
  it('accepts ISO-8601 targetTime, snapshot names and db names', () => {
    for (const t of ['2026-09-24T15:30:00Z', '2026-09-24 15:30:00+00', '2026-09-24T15:30:00.123+01:00']) {
      expect(DbRestorePayload.parse({ ...base, targetTime: t }).targetTime).toBe(t);
    }
    expect(DbRestorePayload.parse({ ...base, snapshotId: 'base_000000010000000000000003' }).snapshotId).toContain('base_');
    expect(DbRestorePayload.parse({ ...base, database: 'app_db' }).database).toBe('app_db');
  });
  it('rejects shell/SQL in targetTime, snapshotId, database', () => {
    expect(DbRestorePayload.safeParse({ ...base, targetTime: `2026-01-01"; id; "` }).success).toBe(false);
    expect(DbRestorePayload.safeParse({ ...base, targetTime: "2026-01-01'" }).success).toBe(false);
    expect(DbRestorePayload.safeParse({ ...base, snapshotId: 'x; reboot' }).success).toBe(false);
    expect(DbRestorePayload.safeParse({ ...base, database: 'a"; id; "' }).success).toBe(false);
    expect(DbRestorePayload.safeParse({ ...base, database: '--host=evil' }).success).toBe(false);
    expect(DbRestorePayload.safeParse({ ...base, conn: { host: 'db', password: 'pw', database: 'x y' } }).success).toBe(false);
  });
});
