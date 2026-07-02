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
