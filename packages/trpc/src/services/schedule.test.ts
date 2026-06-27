import { describe, expect, it } from 'bun:test';
import { intervalMs, isDue, nextRun } from './schedule';

describe('backup schedule next-run calc', () => {
  it('computes interval ms per unit', () => {
    expect(intervalMs({ every: 5, unit: 'minutes' })).toBe(5 * 60_000);
    expect(intervalMs({ every: 2, unit: 'hours' })).toBe(2 * 3_600_000);
    expect(intervalMs({ every: 1, unit: 'days' })).toBe(86_400_000);
  });

  it('rejects non-positive intervals', () => {
    expect(() => intervalMs({ every: 0, unit: 'hours' })).toThrow();
  });

  it('returns the anchor when from is before it', () => {
    const anchor = new Date('2026-06-27T12:00:00.000Z');
    const from = new Date('2026-06-27T11:00:00.000Z');
    expect(nextRun({ every: 1, unit: 'hours' }, anchor, from).toISOString()).toBe(
      anchor.toISOString(),
    );
  });

  it('advances to the next aligned slot strictly after `from`', () => {
    const anchor = new Date('2026-06-27T00:00:00.000Z');
    // 90 minutes after anchor, hourly schedule → next slot is 02:00.
    const from = new Date('2026-06-27T01:30:00.000Z');
    expect(nextRun({ every: 1, unit: 'hours' }, anchor, from).toISOString()).toBe(
      '2026-06-27T02:00:00.000Z',
    );
  });

  it('is catch-up safe (single future slot after many missed)', () => {
    const anchor = new Date('2026-06-01T00:00:00.000Z');
    const from = new Date('2026-06-27T03:10:00.000Z'); // many missed daily slots
    const next = nextRun({ every: 1, unit: 'days' }, anchor, from);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
    // exactly one interval past the last slot <= from
    expect(next.getTime() - from.getTime()).toBeLessThanOrEqual(86_400_000);
  });

  it('exact-slot `from` yields the following slot (strictly after)', () => {
    const anchor = new Date('2026-06-27T00:00:00.000Z');
    const from = new Date('2026-06-27T01:00:00.000Z');
    expect(nextRun({ every: 1, unit: 'hours' }, anchor, from).toISOString()).toBe(
      '2026-06-27T02:00:00.000Z',
    );
  });

  it('isDue compares nextRunAt against now', () => {
    const now = new Date('2026-06-27T12:00:00.000Z');
    expect(isDue(new Date('2026-06-27T11:59:00.000Z'), now)).toBe(true);
    expect(isDue(new Date('2026-06-27T12:01:00.000Z'), now)).toBe(false);
    expect(isDue(null, now)).toBe(false);
  });
});
