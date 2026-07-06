import { describe, expect, it } from 'bun:test';
import {
  encodeScheduleLabel,
  parseLastRunLabel,
  parseScheduleLabel,
  pitrWindow,
  scheduleView,
  snapshotView,
  type DbBackupSchedule,
} from './dbBackup.service';

const SCHEDULE: DbBackupSchedule = {
  cron: '0 */6 * * *',
  engine: 'pg_dump',
  retentionDays: 14,
  pitr: false,
  targetId: 'tgt-1',
};

describe('schedule label codec (swarmy.db.backup.schedule)', () => {
  it('round-trips a full schedule', () => {
    const parsed = parseScheduleLabel(encodeScheduleLabel(SCHEDULE));
    expect(parsed).toEqual(SCHEDULE);
  });

  it('round-trips pitr + dataVolume', () => {
    const s: DbBackupSchedule = {
      cron: '0 3 * * *',
      engine: 'wal-g',
      retentionDays: 7,
      pitr: true,
      dataVolume: 'shop_main-primary-data',
    };
    expect(parseScheduleLabel(encodeScheduleLabel(s))).toEqual(s);
  });

  it('degrades malformed values to null instead of throwing', () => {
    expect(parseScheduleLabel(undefined)).toBeNull();
    expect(parseScheduleLabel('')).toBeNull();
    expect(parseScheduleLabel('not json')).toBeNull();
    expect(parseScheduleLabel('{}')).toBeNull();
    expect(parseScheduleLabel(JSON.stringify({ cron: '0 3 * * *' }))).toBeNull(); // no engine
    expect(
      parseScheduleLabel(JSON.stringify({ cron: '0 3 * * *', engine: 'mysqldump' })),
    ).toBeNull(); // foreign engine
  });

  it('defaults a bad retention to 14 days', () => {
    const parsed = parseScheduleLabel(
      JSON.stringify({ cron: '0 3 * * *', engine: 'pg_dump', retentionDays: -3 }),
    );
    expect(parsed?.retentionDays).toBe(14);
  });
});

describe('last-run label codec (swarmy.db.backup.lastRun)', () => {
  it('parses a success stamp', () => {
    const raw = JSON.stringify({
      at: '2026-06-27T03:00:12.000Z',
      status: 'succeeded',
      engine: 'pg_dump',
      snapshotId: '9f3ac21b',
      sizeBytes: '1842300416',
    });
    expect(parseLastRunLabel(raw)).toEqual({
      at: '2026-06-27T03:00:12.000Z',
      status: 'succeeded',
      engine: 'pg_dump',
      snapshotId: '9f3ac21b',
      sizeBytes: '1842300416',
    });
  });

  it('parses a failure stamp with its error', () => {
    const raw = JSON.stringify({
      at: '2026-06-27T03:00:12.000Z',
      status: 'failed',
      engine: 'wal-g',
      error: 'repository locked',
    });
    expect(parseLastRunLabel(raw)?.error).toBe('repository locked');
  });

  it('rejects unknown statuses and invalid timestamps', () => {
    expect(
      parseLastRunLabel(JSON.stringify({ at: 'nope', status: 'succeeded', engine: 'pg_dump' })),
    ).toBeNull();
    expect(
      parseLastRunLabel(
        JSON.stringify({ at: '2026-06-27T03:00:12.000Z', status: 'meh', engine: 'pg_dump' }),
      ),
    ).toBeNull();
  });
});

describe('snapshotView (restic snapshot → dashboard row)', () => {
  it('reads the engine off the tags and stringifies the size', () => {
    const v = snapshotView({
      id: '9f3ac21b',
      time: '2026-06-27T03:00:12Z',
      tags: ['org:org-1', 'db:shop/main', 'engine:pg_dumpall'],
      paths: [],
      sizeBytes: 123456,
    });
    expect(v.engine).toBe('pg_dumpall');
    expect(v.sizeBytes).toBe('123456');
  });

  it('degrades an unknown engine tag / missing size to nulls', () => {
    const v = snapshotView({
      id: 'abc',
      time: '2026-06-27T03:00:12Z',
      tags: ['engine:mysqldump'],
      paths: [],
    });
    expect(v.engine).toBeNull();
    expect(v.sizeBytes).toBeNull();
  });
});

describe('pitrWindow', () => {
  const now = new Date('2026-07-01T12:00:00.000Z');
  const lastOk = {
    at: '2026-07-01T06:00:00.000Z',
    status: 'succeeded' as const,
    engine: 'wal-g' as const,
  };

  it('spans retention → last successful backup for PITR clusters', () => {
    const w = pitrWindow({ ...SCHEDULE, engine: 'wal-g', pitr: true, retentionDays: 7 }, lastOk, now);
    expect(w).toEqual({ from: '2026-06-24T12:00:00.000Z', to: '2026-07-01T06:00:00.000Z' });
  });

  it('is null without pitr, without a run, or after a failure', () => {
    expect(pitrWindow(SCHEDULE, lastOk, now)).toBeNull(); // pitr off
    expect(pitrWindow({ ...SCHEDULE, pitr: true }, null, now)).toBeNull();
    expect(pitrWindow({ ...SCHEDULE, pitr: true }, { ...lastOk, status: 'failed' }, now)).toBeNull();
  });
});

describe('scheduleView', () => {
  it('derives the next run from the cron (UTC)', () => {
    const v = scheduleView('shop', 'main', SCHEDULE, null, new Date('2026-06-27T05:30:00Z'));
    expect(v.nextRunAt).toBe('2026-06-27T06:00:00.000Z');
    expect(v.lastRunAt).toBeNull();
    expect(v.targetId).toBe('tgt-1');
  });

  it('surfaces the last run and degrades a bad cron to nextRunAt=null', () => {
    const v = scheduleView(
      'shop',
      'main',
      { ...SCHEDULE, cron: 'not a cron' },
      { at: '2026-06-27T03:00:00.000Z', status: 'failed', engine: 'pg_dump', error: 'x' },
      new Date('2026-06-27T05:30:00Z'),
    );
    expect(v.nextRunAt).toBeNull();
    expect(v.lastStatus).toBe('failed');
  });
});

// ── schedule sweep: retention rides every scheduled dispatch ─────────────────

import { runDueDbBackups } from './dbBackup.service';
import { encryptSecret } from '@swarmy/core/crypto';
import type { DbBackupResult } from '@swarmy/core/protocol';

process.env.SWARMY_SECRET_KEY ??= 'test-secret-key-for-db-backup-sweep';

describe('runDueDbBackups (schedule sweep passes retention through)', () => {
  function fakeWorld(schedule: DbBackupSchedule): {
    deps: Parameters<typeof runDueDbBackups>[1];
    dispatches: Array<{ cmd: string; payload: Record<string, unknown> }>;
    audits: Array<{ action: string; metadata: Record<string, unknown> }>;
  } {
    const dispatches: Array<{ cmd: string; payload: Record<string, unknown> }> = [];
    const audits: Array<{ action: string; metadata: Record<string, unknown> }> = [];
    const primary = {
      id: 'svc1',
      name: 'shop_main-db',
      image: 'bitnami/postgresql:16',
      mode: 'replicated' as const,
      desiredReplicas: 1,
      runningReplicas: 1,
      labels: {
        'com.docker.stack.namespace': 'shop',
        'swarmy.db.cluster': 'main',
        'swarmy.db.role': 'primary',
        'swarmy.db.backup.schedule': encodeScheduleLabel(schedule),
      },
      env: ['POSTGRESQL_PASSWORD=pw', 'POSTGRESQL_DATABASE=app'],
      networks: [],
      ports: [],
    };
    const hub = {
      managerNode: () => 'node1',
      isOnline: () => true,
      liveInventory: () => ({ services: [primary], containers: [] }),
      dispatch: (nodeId: string, cmd: string, payload: Record<string, unknown>) => {
        dispatches.push({ cmd, payload });
        if (cmd === 'db.backup') {
          const result: DbBackupResult = {
            snapshotId: 'snap1',
            engine: schedule.engine,
            sizeBytes: 10,
            databases: ['app'],
            retention: { retentionDays: schedule.retentionDays, snapshotsRemoved: 3 },
          };
          return Promise.resolve(result);
        }
        return Promise.resolve({});
      },
    };
    const db = {
      organization: { findMany: () => Promise.resolve([{ id: 'org1' }]) },
      backupTarget: {
        findFirst: () =>
          Promise.resolve({
            id: 'tgt-1',
            kind: 'S3',
            endpoint: 'https://s3.example.com',
            bucket: 'b',
            prefix: null,
            region: null,
            credentialRef: null,
            secretKeyRef: null,
            resticPasswordRef: encryptSecret('restic-pw'),
            enabled: true,
          }),
      },
      auditLog: {
        create: (a: { data: { action: string; metadata: Record<string, unknown> } }) => {
          audits.push({ action: a.data.action, metadata: a.data.metadata });
          return Promise.resolve({});
        },
      },
    };
    return {
      deps: { db, hub, auth: {} } as unknown as Parameters<typeof runDueDbBackups>[1],
      dispatches,
      audits,
    };
  }

  it('threads the schedule label retentionDays into the db.backup dispatch and audits the prune', async () => {
    const schedule: DbBackupSchedule = {
      cron: '* * * * *',
      engine: 'pg_dump',
      retentionDays: 21,
      pitr: false,
      targetId: 'tgt-1',
    };
    const { deps, dispatches, audits } = fakeWorld(schedule);
    await runDueDbBackups(new Date('2026-07-01T00:00:30Z'), deps);

    const backup = dispatches.find((d) => d.cmd === 'db.backup');
    expect(backup).toBeDefined();
    expect(backup!.payload.retentionDays).toBe(21);
    expect(backup!.payload.tags).toEqual(['org:org1', 'db:shop/main', 'engine:pg_dump']);

    const prune = audits.find((a) => a.action === 'backup.retention.prune');
    expect(prune).toBeDefined();
    expect(prune!.metadata.snapshotsRemoved).toBe(3);
    expect(prune!.metadata.retentionDays).toBe(21);
  });
});
