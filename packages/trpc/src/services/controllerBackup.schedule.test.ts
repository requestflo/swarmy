import { describe, expect, test } from 'bun:test';
import { nextRunFrom } from './controllerBackup.service';

describe('nextRunFrom', () => {
  test('daily cron rolls to today if the time is still ahead', () => {
    const from = new Date('2026-06-27T01:00:00.000Z');
    // 03:00 every day, in local time of the runner — assert it advances forward.
    const next = nextRunFrom('0 3 * * *', from);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
  });

  test('daily cron rolls to tomorrow if the time has passed', () => {
    const from = new Date('2026-06-27T23:30:00.000Z');
    const next = nextRunFrom('0 3 * * *', from);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
    // strictly within ~24h
    expect(next.getTime() - from.getTime()).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 60_000);
  });

  test('non-cron schedule falls back to +24h', () => {
    const from = new Date('2026-06-27T10:00:00.000Z');
    const next = nextRunFrom('@daily', from);
    expect(next.getTime() - from.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});
