import { describe, expect, it } from 'bun:test';
import { encryptSecret } from '@swarmy/core/crypto';
import type { OrgContext } from '../context';
import { encodeScheduleLabel, runDueDbBackups, setDbBackupSchedule, type DbBackupSchedule } from './dbBackup.service';
import { parseCopyLabel } from './dbBackupCopy.label';
import { setDbBackupSecondary } from './dbBackupCopy.service';
import { seedKvRows } from './swarm-kv.service';

/**
 * "Also copy to" on a DB schedule, end to end over a fake swarm: the
 * scheduled save is copied into the second destination by a second
 * `db.backup` (the volume schedules' path), the outcome is stamped as
 * `swarmy.db.backup.copy`, and a failed copy never fails the save.
 */

process.env.SWARMY_SECRET_KEY ??= 'test-secret-key-for-db-backup-copy';

type Dispatch = { cmd: string; payload: Record<string, unknown> };
const target = (id: string, bucket: string) => ({
  id, name: id, kind: 'S3', endpoint: 'https://s3.example.com', bucket, prefix: null, region: null,
  credentialRef: null, secretKeyRef: null, resticPasswordRef: encryptSecret('pw'), enabled: true, createdAt: new Date(Date.now() - (id === 'main' ? 2 : 1) * 60_000),
});

function world(schedule: DbBackupSchedule, opts: { copyFails?: boolean; oldAgent?: boolean } = {}) {
  const dispatches: Dispatch[] = [];
  const audits: Array<{ action: string; metadata: Record<string, unknown> }> = [];
  const labels: Record<string, string> = {
    'com.docker.stack.namespace': 'shop', 'swarmy.db.cluster': 'main', 'swarmy.db.role': 'primary',
    'swarmy.db.backup.schedule': encodeScheduleLabel(schedule), 'swarmy.db.dataVolume': 'shop_main-primary-data',
  };
  const primary = { id: 's1', name: 'shop_main-primary', image: 'pg', mode: 'replicated' as const, desiredReplicas: 1, runningReplicas: 1, labels, env: ['POSTGRES_PASSWORD=pw'], networks: [], ports: [] };
  const hub = {
    managerNode: () => 'node1',
    isOnline: () => true,
    liveInventory: () => ({ services: [primary], containers: [] }),
    onlineNodeIds: () => ['node1'],
    swarmNodeIdFor: () => 'sw1',
    agentBuildFor: () => ({ version: '1.9.0', capabilities: opts.oldAgent ? ['dbPitrWindow'] : ['dbPitrWindow', 'dbWalgCopy'] }),
    dispatch: (_n: string, cmd: string, payload: Record<string, unknown>) => {
      dispatches.push({ cmd, payload });
      if (cmd === 'service.updateLabels') Object.assign(labels, payload.add);
      if (cmd === 'db.walgCopy') return Promise.resolve(WALG_COPIED);
      if (cmd !== 'db.backup') return Promise.resolve({});
      const repo = (payload.repo as { repo: string }).repo;
      if (opts.copyFails && repo.includes('/copy')) return Promise.reject(new Error('AccessDenied: the off-site bucket refused the upload'));
      return Promise.resolve({ snapshotId: repo.includes('/copy') ? 'copy1' : 'save1', engine: 'pg_dump', sizeBytes: 42, databases: ['app'] });
    },
  };
  const db = {
    organization: { findMany: () => Promise.resolve([{ id: 'org1' }]) },
    auditLog: { create: (a: { data: { action: string; metadata: Record<string, unknown> } }) => (audits.push(a.data), Promise.resolve({})) },
  };
  seedKvRows(hub as never, 'org1', 'bkp-target', [target('main', 'main'), target('copy', 'copy'), { ...target('nvme', '/srv/backups'), kind: 'NODE', endpoint: null }]);
  const ctx = { db, hub, activeOrgId: 'org1', user: { id: 'u1' } } as unknown as OrgContext;
  return { deps: { db, hub, auth: {} } as never, ctx, dispatches, audits, labels };
}

const WALG_COPIED = {
  backupName: 'save1',
  backups: [{ name: 'save1', finishTime: '2026-10-27T03:01:00.000Z', sizeBytes: 1_842_300_416 }],
  window: { from: '2026-10-27T03:01:00.000Z', to: '2026-10-27T03:02:00.000Z' },
  checkedAt: '2026-10-27T03:02:30.000Z',
};
const SCHED: DbBackupSchedule = { cron: '* * * * *', engine: 'pg_dump', retentionDays: 7, pitr: false, targetId: 'main', secondaryTargetId: 'copy' };
const NOW = new Date('2026-10-27T03:00:30Z');

describe('the scheduled save is copied to the second destination', () => {
  it('a second db.backup into the copy, same tags and retention; stamped and audited as a copy', async () => {
    const w = world(SCHED);
    await runDueDbBackups(NOW, w.deps);
    const backups = w.dispatches.filter((d) => d.cmd === 'db.backup');
    expect(backups.map((b) => (b.payload.repo as { repo: string }).repo)).toEqual(['s3:https://s3.example.com/main', 's3:https://s3.example.com/copy']);
    expect(backups[1]!.payload.tags).toEqual(backups[0]!.payload.tags);
    expect(backups[1]!.payload.retentionDays).toBe(7);
    const rec = parseCopyLabel(w.labels['swarmy.db.backup.copy']);
    expect(rec).toMatchObject({ targetId: 'copy', status: 'succeeded', ok: { snapshotId: 'copy1', sizeBytes: '42' } });
    expect(JSON.parse(w.labels['swarmy.db.backup.lastRun']!)).toMatchObject({ status: 'succeeded', snapshotId: 'save1' });
    expect(w.audits.map((a) => a.action)).toEqual(['db.backup', 'db.backup.copy']);
    expect(w.audits[1]!.metadata).toMatchObject({ targetId: 'copy', snapshotId: 'copy1', copyOf: 'save1' });
  });

  it('a failed copy is stamped and audited, and the save stays a success', async () => {
    const w = world(SCHED, { copyFails: true });
    await runDueDbBackups(NOW, w.deps);
    expect(parseCopyLabel(w.labels['swarmy.db.backup.copy'])).toMatchObject({ status: 'failed', error: 'AccessDenied: the off-site bucket refused the upload' });
    expect(JSON.parse(w.labels['swarmy.db.backup.lastRun']!)).toMatchObject({ status: 'succeeded' });
    expect(w.audits.map((a) => a.action)).toEqual(['db.backup', 'db.backup.copy.failed']);
  });

  it('no second destination: one save, no copy label', async () => {
    const w = world({ ...SCHED, secondaryTargetId: undefined });
    await runDueDbBackups(NOW, w.deps);
    expect(w.dispatches.filter((d) => d.cmd === 'db.backup')).toHaveLength(1);
    expect(w.labels['swarmy.db.backup.copy']).toBeUndefined();
  });
});

describe('a wal-g PITR schedule is copied with wal-g copy', () => {
  const WALG: DbBackupSchedule = { ...SCHED, engine: 'wal-g', pitr: true };

  it('after the base backup: one db.walgCopy from the main to the second destination, stamped with how far the copy restores', async () => {
    const w = world(WALG);
    await runDueDbBackups(NOW, w.deps);
    expect(w.dispatches.filter((d) => d.cmd === 'db.backup')).toHaveLength(1);
    const copy = w.dispatches.find((d) => d.cmd === 'db.walgCopy')!;
    expect(copy.payload).toMatchObject({ engine: 'wal-g', backupName: 'save1' });
    expect((copy.payload.from as { repo: string }).repo).toBe('s3:https://s3.example.com/main');
    expect((copy.payload.to as { repo: string }).repo).toBe('s3:https://s3.example.com/copy');
    expect(parseCopyLabel(w.labels['swarmy.db.backup.copy'])).toMatchObject({
      status: 'succeeded',
      ok: { snapshotId: 'save1', sizeBytes: '1842300416', restoresTo: '2026-10-27T03:02:00.000Z' },
    });
  });

  it('an agent that predates the command is never sent it: the copy fails in plain words', async () => {
    const w = world(WALG, { oldAgent: true });
    await runDueDbBackups(NOW, w.deps);
    expect(w.dispatches.some((d) => d.cmd === 'db.walgCopy')).toBe(false);
    expect(parseCopyLabel(w.labels['swarmy.db.backup.copy'])?.error).toContain('predates dbWalgCopy');
  });

  it('wal-g copies into an S3 bucket only', async () => {
    const w = world({ ...WALG, secondaryTargetId: undefined });
    await expect(setDbBackupSecondary(w.ctx, { stack: 'shop', cluster: 'main', secondaryTargetId: 'nvme' })).rejects.toThrow('S3 bucket only');
    expect((await setDbBackupSecondary(w.ctx, { stack: 'shop', cluster: 'main', secondaryTargetId: 'copy' })).secondaryTargetId).toBe('copy');
  });
});

describe('setting the second destination', () => {
  it('rewrites only that field of the schedule label; null drops it', async () => {
    const w = world({ ...SCHED, secondaryTargetId: undefined });
    const v = await setDbBackupSecondary(w.ctx, { stack: 'shop', cluster: 'main', secondaryTargetId: 'copy' });
    expect(v.secondaryTargetId).toBe('copy');
    expect(JSON.parse(w.labels['swarmy.db.backup.schedule']!)).toEqual({ cron: '* * * * *', engine: 'pg_dump', retentionDays: 7, pitr: false, targetId: 'main', secondaryTargetId: 'copy' });
    await setDbBackupSecondary(w.ctx, { stack: 'shop', cluster: 'main', secondaryTargetId: null });
    expect(JSON.parse(w.labels['swarmy.db.backup.schedule']!).secondaryTargetId).toBeUndefined();
  });

  it('refuses the main destination itself, an engine that keeps one repo, and a cluster with no schedule', async () => {
    const same = world(SCHED);
    await expect(setDbBackupSecondary(same.ctx, { stack: 'shop', cluster: 'main', secondaryTargetId: 'main' })).rejects.toThrow('must differ');
    const one = world({ ...SCHED, engine: 'pgbackrest', secondaryTargetId: undefined });
    await expect(setDbBackupSecondary(one.ctx, { stack: 'shop', cluster: 'main', secondaryTargetId: 'copy' })).rejects.toThrow('one place');
    const none = world(SCHED);
    delete none.labels['swarmy.db.backup.schedule'];
    await expect(setDbBackupSecondary(none.ctx, { stack: 'shop', cluster: 'main', secondaryTargetId: 'copy' })).rejects.toThrow('schedule first');
  });

  it('saving the schedule keeps the second destination', async () => {
    const w = world(SCHED);
    const v = await setDbBackupSchedule(w.ctx, { enabled: true, stack: 'shop', cluster: 'main', cron: '0 4 * * *', engine: 'pg_dumpall', retentionDays: 14, pitr: false, targetId: 'main' });
    expect(v?.secondaryTargetId).toBe('copy');
  });
});
