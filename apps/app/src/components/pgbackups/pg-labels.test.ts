import { describe, expect, test } from 'bun:test';
import type { DbBackupScheduleView } from '@swarmy/core';
import { primaryService, renderedDbLabels } from './pg-labels';

const schedule: DbBackupScheduleView = {
  stack: 'data',
  cluster: 'main',
  cron: '0 */6 * * *',
  engine: 'wal-g',
  retentionDays: 14,
  pitr: true,
  targetId: 'tgt-1',
  dataVolume: 'data_main-primary-data',
  lastRunAt: '2026-10-23T11:10:00.000Z',
  lastStatus: 'succeeded',
  lastError: null,
  nextRunAt: null,
  auto: false,
};

describe('renderedDbLabels', () => {
  test('the schedule label in the service’s field order, plus the PITR flag', () => {
    const out = renderedDbLabels(schedule, primaryService('data', 'main'));
    expect(out).toContain('# service data_main-primary (live labels)');
    expect(out).toContain(
      'swarmy.db.backup.schedule={"cron":"0 */6 * * *","engine":"wal-g","retentionDays":14,"pitr":true,"targetId":"tgt-1","dataVolume":"data_main-primary-data"}',
    );
    expect(out).toContain('swarmy.db.backup.pitr=true');
    expect(out).toContain('last 2026-10-23T11:10:00.000Z, succeeded');
  });

  test('a new keep window previews the label it would write', () => {
    expect(renderedDbLabels(schedule, 'x', 30)).toContain('"retentionDays":30');
  });

  test('the auto marker shows until someone saves', () => {
    const auto = { ...schedule, engine: 'pg_dump' as const, pitr: false, targetId: null, dataVolume: null, auto: true };
    expect(renderedDbLabels(auto, 'x')).toContain('"pitr":false,"auto":true}');
    expect(renderedDbLabels(auto, 'x', 7)).not.toContain('auto');
    expect(renderedDbLabels(auto, 'x')).not.toContain('swarmy.db.backup.pitr=');
  });

  test('no schedule says so', () => {
    expect(renderedDbLabels(null, 'x')).toContain('no recurring backup');
  });
});
