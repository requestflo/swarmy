import { describe, expect, it } from 'bun:test';
import { encryptSecret } from '@swarmy/core/crypto';
import type { OrgContext } from '../context';
import { restoreDb, type RestoreDbInput } from './dbBackup.service';
import { latestRestorable, overwritesSource, safetyBackupPlan } from './dbRestoreSafety.service';
import { seedKvRows } from './swarm-kv.service';

/**
 * An in-place restore of a managed Postgres saves the current data first
 * (through the normal backup path), waits for it, and refuses if it fails,
 * unless the caller explicitly skips it (audited). Against an in-memory hub.
 */

process.env.SWARMY_SECRET_KEY ??= 'test-secret-key-for-db-restore-safety';

const pure = { stack: 'shop', cluster: 'main' };

describe('which restores save first, and what', () => {
  it('only a restore that lands on its own source cluster overwrites it', () => {
    expect(overwritesSource(pure)).toBe(true);
    expect(overwritesSource({ ...pure, targetCluster: 'main' })).toBe(true);
    expect(overwritesSource({ ...pure, targetCluster: 'main-restore' })).toBe(false);
    expect(overwritesSource({ ...pure, targetStack: 'preview-12' })).toBe(false);
  });
  it('saves the whole cluster for a PITR or pg_dumpall load, else the one database', () => {
    expect(safetyBackupPlan({ mode: 'pitr', engine: 'wal-g' })).toEqual({ engine: 'pg_dumpall' });
    expect(safetyBackupPlan({ mode: 'in-place', engine: 'pg_dumpall' })).toEqual({ engine: 'pg_dumpall' });
    expect(safetyBackupPlan({ mode: 'in-place', engine: 'pg_dump' })).toEqual({ engine: 'pg_dump' });
    expect(safetyBackupPlan({ mode: 'single-database', engine: 'pg_dump', database: 'orders' })).toEqual({ engine: 'pg_dump', database: 'orders' });
  });
  it('"latest" is the newest save this engine can load', () => {
    const saves = [
      { id: 'old', time: '2026-10-01T03:00:00Z', engine: 'pg_dump' as const },
      { id: 'rep', time: '2026-10-02T03:00:00Z', engine: 'snapshot-from-replica' as const },
      { id: 'all', time: '2026-10-03T03:00:00Z', engine: 'pg_dumpall' as const },
    ];
    expect(latestRestorable(saves, 'pg_dump')).toBe('rep');
    expect(latestRestorable(saves, 'pg_dumpall')).toBe('all');
    expect(latestRestorable([], 'pg_dump')).toBeNull();
  });
});

function world(opts: { backupFails?: string; saves?: Array<{ id: string; time: string; tags: string[] }> } = {}) {
  const calls: Array<{ cmd: string; payload: Record<string, unknown> }> = [];
  const audits: Array<{ action: string; metadata: Record<string, unknown> }> = [];
  const primary = (cluster: string) => ({
    id: `svc-${cluster}`, name: `shop_${cluster}-primary`, image: 'pgvector/pgvector:pg17', mode: 'replicated' as const,
    desiredReplicas: 1, runningReplicas: 1,
    labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.db.cluster': cluster, 'swarmy.db.role': 'primary', 'swarmy.db.dataVolume': `shop_${cluster}-primary-data` },
    env: ['POSTGRES_PASSWORD=pw', 'POSTGRES_DB=app'], networks: [], ports: [],
  });
  const hub = {
    managerNode: () => 'n1', isOnline: () => true, onlineNodeIds: () => ['n1'], latestContainers: () => [],
    swarmNodeIdFor: () => undefined,
    liveInventory: () => ({ services: [primary('main'), primary('main-restore')], containers: [] }),
    dispatch: async (_n: string, cmd: string, payload: Record<string, unknown>) => {
      calls.push({ cmd, payload });
      if (cmd === 'db.backup') {
        if (opts.backupFails) throw new Error(opts.backupFails);
        return { snapshotId: 'safe1', engine: payload.engine, sizeBytes: 10, databases: ['app'] };
      }
      if (cmd === 'backup.list') return { snapshots: (opts.saves ?? []).map((s) => ({ ...s, paths: [] })) };
      if (cmd === 'db.restore') {
        if (payload.mode === 'pitr') throw new Error('stop here');
        return { mode: payload.mode, engine: payload.engine, bytesRestored: 5 };
      }
      return {};
    },
  };
  const db = { auditLog: { create: async (a: { data: { action: string; metadata: Record<string, unknown> } }) => (audits.push(a.data), {}) } };
  seedKvRows(hub as never, 'org1', 'bkp-target', [
    { id: 'tgt-1', name: 'offsite', kind: 'S3', endpoint: 'https://s3.example.com', bucket: 'b', prefix: null, region: null, credentialRef: null, secretKeyRef: null, resticPasswordRef: encryptSecret('pw'), enabled: true },
  ]);
  const ctx = { db, hub, user: { id: 'u1' }, activeOrgId: 'org1', session: null, reqHeaders: new Headers() } as unknown as OrgContext;
  return { ctx, calls, audits, cmds: () => calls.map((c) => c.cmd) };
}

const inPlace: RestoreDbInput = { ...pure, engine: 'pg_dump', mode: 'in-place', snapshotId: 'pick1', targetId: 'tgt-1' };

describe('restoreDb saves the current data before writing over it', () => {
  it('in place: a tagged safety copy finishes first, then the picked save is restored', async () => {
    const w = world();
    const r = await restoreDb(w.ctx, inPlace);
    expect(w.cmds()).toEqual(['db.backup', 'db.restore']); // no lastRun stamp: the schedule's label is left alone
    const backup = w.calls[0]!.payload;
    expect(backup.engine).toBe('pg_dump');
    expect(backup.tags).toEqual(['org:org1', 'db:shop/main', 'engine:pg_dump', 'reason:pre-restore']);
    expect(w.calls[1]!.payload.snapshotId).toBe('pick1');
    expect(r.safetySnapshotId).toBe('safe1');
    expect(w.audits.find((a) => a.action === 'db.backup')?.metadata.reason).toBe('pre-restore');
    expect(w.audits.find((a) => a.action === 'db.restore')?.metadata).toMatchObject({ safetySnapshotId: 'safe1', safetySkipped: false });
  });

  it('"latest" is pinned before the safety copy, so the restore never puts the current data back', async () => {
    const w = world({ saves: [{ id: 'night1', time: '2026-10-23T03:00:00Z', tags: ['engine:pg_dump'] }] });
    await restoreDb(w.ctx, { ...inPlace, snapshotId: undefined });
    expect(w.cmds()).toEqual(['backup.list', 'db.backup', 'db.restore']);
    expect(w.calls[2]!.payload.snapshotId).toBe('night1');
  });

  it('refuses in plain words, and restores nothing, when the safety copy fails', async () => {
    const w = world({ backupFails: 'pg_dump: connection refused' });
    await expect(restoreDb(w.ctx, inPlace)).rejects.toThrow(
      /couldn't save the current data of shop\/main first, so nothing was restored: pg_dump: connection refused/,
    );
    expect(w.cmds()).not.toContain('db.restore');
  });

  it('skipSafetyBackup: true restores without one, and says so in the audit', async () => {
    const w = world({ backupFails: 'server down' });
    const r = await restoreDb(w.ctx, { ...inPlace, skipSafetyBackup: true });
    expect(w.cmds()).toEqual(['db.restore']);
    expect(r.safetySnapshotId).toBeNull();
    expect(w.audits.map((a) => a.action)).toEqual(['db.restore.safety.skip', 'db.restore']);
    expect(w.audits[1]!.metadata).toMatchObject({ safetySnapshotId: null, safetySkipped: true });
  });

  it('a restore into another cluster is a copy: nothing is saved first', async () => {
    const w = world();
    const r = await restoreDb(w.ctx, { ...inPlace, mode: 'clone-to-new-cluster', targetCluster: 'main-restore' });
    expect(w.cmds()).toEqual(['db.restore']);
    expect(r.safetySnapshotId).toBeNull();
    expect(w.audits.find((a) => a.action === 'db.restore')?.metadata).toMatchObject({ safetySnapshotId: null, safetySkipped: false });
  });

  it('PITR in place: the whole cluster is saved before the server is stopped', async () => {
    const w = world();
    await expect(restoreDb(w.ctx, { ...pure, engine: 'wal-g', mode: 'pitr', targetTime: '2026-10-23T10:00:00Z' })).rejects.toThrow(/stop here/);
    expect(w.cmds().slice(0, 2)).toEqual(['db.backup', 'service.scale']);
    expect(w.calls[0]!.payload.engine).toBe('pg_dumpall');
    expect(w.audits.find((a) => a.action === 'db.restore')?.metadata).toMatchObject({ status: 'failed', safetySnapshotId: 'safe1' });
  });
});
