import { describe, expect, test } from 'bun:test';
import type { JobRunView, ScheduledJobView } from '@swarmy/core';
import { dayWords, lanes, plainSchedule, yesterdayUtc } from './yesterday-model';

const NOW = Date.parse('2026-10-23T10:20:00Z');
const job = (id: string): ScheduledJobView => ({ id, name: id, schedule: '0 * * * *', scheduleText: 'every hour' }) as ScheduledJobView;
const run = (jobId: string, at: string, status: JobRunView['status'], attempt = 1): JobRunView =>
  ({ id: `${jobId}-${at}-${attempt}`, jobId, status, exitCode: null, outputTail: null, attempt, startedAt: `2026-10-22T${at}:00Z`, finishedAt: null }) as JobRunView;

describe('yesterday, hour by hour', () => {
  test('the window is yesterday in UTC', () => {
    const w = yesterdayUtc(NOW);
    expect(new Date(w.from).toISOString()).toBe('2026-10-22T00:00:00.000Z');
    expect(new Date(w.to).toISOString()).toBe('2026-10-23T00:00:00.000Z');
  });

  test('runs land in their hour; today’s are left out; retries are told apart', () => {
    const runs = new Map([
      ['a', [run('a', '04:00', 'failed', 1), run('a', '04:05', 'succeeded', 2), run('a', '13:00', 'succeeded')]],
      ['b', [run('b', '13:15', 'failed'), { ...run('b', '00:00', 'succeeded'), startedAt: '2026-10-23T00:10:00Z' }]],
    ]);
    const ls = lanes([job('a'), job('b')], runs, yesterdayUtc(NOW));
    expect(ls[0]!.cells[4]!.runs.length).toBe(2);
    expect(ls[0]!.cells[4]!.failed).toBe(1);
    expect(ls[1]!.cells.reduce((n, c) => n + c.runs.length, 0)).toBe(1);
    expect(dayWords(ls, runs)).toBe('4 runs · 2 failed, 1 retried ok');
  });

  test('plain words for a schedule', () => {
    expect(plainSchedule({ schedule: '0 2 * * *', scheduleText: 'every day 02:00' })).toBe('Every day at 02:00 UTC');
    expect(plainSchedule({ schedule: '0 3 1 * *', scheduleText: 'monthly on day 1 at 03:00' })).toBe('Monthly on day 1 at 03:00 UTC');
    expect(plainSchedule({ schedule: '*/15 * * * *', scheduleText: 'every 15 minutes' })).toBe('Every 15 minutes');
    expect(plainSchedule({ schedule: '5 4 * 2 1', scheduleText: '5 4 * 2 1' })).toBeNull();
  });
});
