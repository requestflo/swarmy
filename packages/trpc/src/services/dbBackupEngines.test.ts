import { afterEach, describe, expect, it } from 'bun:test';
import { encryptSecret } from '@swarmy/core/crypto';
import { PGBACKREST_NO_IMAGE } from '@swarmy/core/protocol';
import { encodeScheduleLabel, runDueDbBackups, type DbBackupSchedule } from './dbBackup.service';
import { assertEngineOffered, dbBackupEngineOffers, engineImageFor } from './dbBackupEngines';
import { seedKvRows } from './swarm-kv.service';

process.env.SWARMY_SECRET_KEY ??= 'test-secret-key-for-db-backup-engines';

/**
 * pgBackRest has no image swarmy can name (none upstream, none built), so the
 * engine is offered only with an operator's `SWARMY_PGBACKREST_IMAGE`, and is
 * refused in plain words — before anything is dispatched — without one.
 */
const OPS_IMAGE = 'registry.example.com/ops/pgbackrest:2.54';

describe('which DB backup engines this controller runs', () => {
  it('pgbackrest is not offered without an operator image, with the reason', () => {
    const offers = dbBackupEngineOffers({});
    expect(offers.map((o) => `${o.engine}:${o.offered}`)).toEqual([
      'pg_dump:true', 'pg_dumpall:true', 'snapshot-from-replica:true', 'wal-g:true', 'pgbackrest:false',
    ]);
    expect(offers.find((o) => o.engine === 'pgbackrest')!.reason).toBe(PGBACKREST_NO_IMAGE);
    expect(() => assertEngineOffered('pgbackrest', {})).toThrow(PGBACKREST_NO_IMAGE);
    expect(() => assertEngineOffered('wal-g', {})).not.toThrow();
    expect(engineImageFor('pgbackrest', { SWARMY_PGBACKREST_IMAGE: '  ' })).toEqual({});
  });

  it('an operator image offers pgbackrest and rides every pgbackrest dispatch; other engines keep their BOM image', () => {
    const env = { SWARMY_PGBACKREST_IMAGE: ` ${OPS_IMAGE} ` };
    expect(dbBackupEngineOffers(env).every((o) => o.offered && o.reason === null)).toBe(true);
    expect(engineImageFor('pgbackrest', env)).toEqual({ engineImage: OPS_IMAGE });
    expect(engineImageFor('wal-g', env)).toEqual({});
  });
});

describe('a scheduled pgbackrest backup', () => {
  const prev = process.env.SWARMY_PGBACKREST_IMAGE;
  afterEach(() => {
    if (prev === undefined) delete process.env.SWARMY_PGBACKREST_IMAGE;
    else process.env.SWARMY_PGBACKREST_IMAGE = prev;
  });

  function world() {
    const schedule: DbBackupSchedule = { cron: '* * * * *', engine: 'pgbackrest', retentionDays: 7, pitr: true, targetId: 'tgt-1' };
    const dispatches: Array<{ cmd: string; payload: Record<string, unknown> }> = [];
    const primary = {
      id: 'svc1', name: 'shop_main-primary', image: 'pgvector/pgvector:pg17', mode: 'replicated' as const,
      desiredReplicas: 1, runningReplicas: 1, networks: [], ports: [], env: ['POSTGRES_PASSWORD=pw', 'POSTGRES_DB=app'],
      labels: {
        'com.docker.stack.namespace': 'shop', 'swarmy.db.cluster': 'main', 'swarmy.db.role': 'primary',
        'swarmy.db.dataVolume': 'shop_main-primary-data', 'swarmy.db.backup.schedule': encodeScheduleLabel(schedule),
      },
    };
    const hub = {
      managerNode: () => 'node1',
      isOnline: () => true,
      onlineNodeIds: () => ['node1'],
      swarmNodeIdFor: () => undefined,
      liveInventory: () => ({ services: [primary], containers: [] }),
      dispatch: async (_n: string, cmd: string, payload: Record<string, unknown>) => {
        dispatches.push({ cmd, payload });
        return cmd === 'db.backup' ? { snapshotId: 'pgbackrest:latest', engine: 'pgbackrest', sizeBytes: 0, databases: ['*'] } : {};
      },
    };
    const db = { organization: { findMany: async () => [{ id: 'org1' }] }, auditLog: { create: async () => ({}) } };
    seedKvRows(hub as never, 'org1', 'bkp-target', [
      { id: 'tgt-1', name: 'offsite', kind: 'S3', endpoint: 'https://s3.example.com', bucket: 'b', prefix: null, region: null,
        credentialRef: null, secretKeyRef: null, resticPasswordRef: encryptSecret('restic-pw'), enabled: true },
    ]);
    const deps = { db, hub, auth: {} } as unknown as Parameters<typeof runDueDbBackups>[1];
    return { deps, dispatches };
  }

  it('without an image: nothing is dispatched, and the last run says why', async () => {
    delete process.env.SWARMY_PGBACKREST_IMAGE;
    const { deps, dispatches } = world();
    await runDueDbBackups(new Date('2026-10-25T00:00:30Z'), deps);
    expect(dispatches.some((d) => d.cmd === 'db.backup')).toBe(false);
    const stamp = dispatches.find((d) => d.cmd === 'service.updateLabels')!;
    const lastRun = JSON.parse((stamp.payload.add as Record<string, string>)['swarmy.db.backup.lastRun']!);
    expect(lastRun).toMatchObject({ status: 'failed', engine: 'pgbackrest', error: PGBACKREST_NO_IMAGE });
  });

  it("with the operator's image: the backup runs on it", async () => {
    process.env.SWARMY_PGBACKREST_IMAGE = OPS_IMAGE;
    const { deps, dispatches } = world();
    await runDueDbBackups(new Date('2026-10-25T00:00:30Z'), deps);
    expect(dispatches.find((d) => d.cmd === 'db.backup')!.payload.engineImage).toBe(OPS_IMAGE);
  });
});
