import { describe, expect, it } from 'bun:test';
import { cronNext, cronNextN, describeCron, isJobDue, parseCron } from './schedule';

/**
 * B2 scheduled jobs — thorough cron nextRun math (DOW, ranges, steps) plus the
 * job due rule and the human schedule descriptions. All UTC (schedule.ts
 * evaluates cron in UTC).
 */

const at = (iso: string): Date => new Date(iso);
const next = (expr: string, from: string): string | null =>
  cronNext(parseCron(expr), at(from))?.toISOString() ?? null;

describe('cronNext — day-of-week', () => {
  // 2026-07-02 is a Thursday (dow 4).
  it('jumps to the next matching weekday', () => {
    expect(next('0 9 * * 1', '2026-07-02T10:00:00Z')).toBe('2026-07-06T09:00:00.000Z'); // Mon
    expect(next('30 6 * * 5', '2026-07-02T10:00:00Z')).toBe('2026-07-03T06:30:00.000Z'); // Fri
  });

  it('treats 7 as Sunday', () => {
    expect(next('0 0 * * 7', '2026-07-02T00:00:00Z')).toBe('2026-07-05T00:00:00.000Z');
    expect(next('0 0 * * 0', '2026-07-02T00:00:00Z')).toBe('2026-07-05T00:00:00.000Z');
  });

  it('same day when the time has not passed yet', () => {
    expect(next('0 23 * * 4', '2026-07-02T10:00:00Z')).toBe('2026-07-02T23:00:00.000Z');
  });

  it('weekday ranges skip the weekend', () => {
    // Friday 18:00 → next weekday 09:00 is Monday.
    expect(next('0 9 * * 1-5', '2026-07-03T18:00:00Z')).toBe('2026-07-06T09:00:00.000Z');
  });

  it('dow lists pick the nearest member', () => {
    // Thu → next of Mon,Wed,Fri is Fri.
    expect(next('15 12 * * 1,3,5', '2026-07-02T13:00:00Z')).toBe('2026-07-03T12:15:00.000Z');
  });

  it('applies the dom/dow OR rule', () => {
    // 15th OR Monday, whichever comes first from Thu Jul 2 → Mon Jul 6.
    expect(next('0 0 15 * 1', '2026-07-02T01:00:00Z')).toBe('2026-07-06T00:00:00.000Z');
    // …and from Mon Jul 13 the 15th (Wed) comes before next Monday.
    expect(next('0 0 15 * 1', '2026-07-13T01:00:00Z')).toBe('2026-07-15T00:00:00.000Z');
  });
});

describe('cronNext — ranges and steps', () => {
  it('minute steps stay within the hour grid', () => {
    expect(next('*/15 * * * *', '2026-07-02T10:07:00Z')).toBe('2026-07-02T10:15:00.000Z');
    expect(next('*/15 * * * *', '2026-07-02T10:45:00Z')).toBe('2026-07-02T11:00:00.000Z');
  });

  it('ranged steps only fire inside the range', () => {
    // 9-17/4 → 9, 13, 17.
    expect(next('0 9-17/4 * * *', '2026-07-02T09:30:00Z')).toBe('2026-07-02T13:00:00.000Z');
    expect(next('0 9-17/4 * * *', '2026-07-02T17:30:00Z')).toBe('2026-07-03T09:00:00.000Z');
  });

  it('value-anchored steps run to the field max (vixie compat)', () => {
    // `5/20` in minutes = 5, 25, 45.
    expect(next('5/20 * * * *', '2026-07-02T10:26:00Z')).toBe('2026-07-02T10:45:00.000Z');
    expect(next('5/20 * * * *', '2026-07-02T10:46:00Z')).toBe('2026-07-02T11:05:00.000Z');
  });

  it('dom ranges cross month boundaries', () => {
    expect(next('0 0 28-31 * *', '2026-02-28T01:00:00Z')).toBe('2026-03-28T00:00:00.000Z'); // no Feb 29 in 2026
    expect(next('0 0 28-31 * *', '2026-03-30T01:00:00Z')).toBe('2026-03-31T00:00:00.000Z');
  });

  it('month lists skip to the listed month', () => {
    expect(next('0 6 1 3,9 *', '2026-07-02T00:00:00Z')).toBe('2026-09-01T06:00:00.000Z');
  });

  it('Feb 30 never fires (null within the scan horizon)', () => {
    expect(cronNext(parseCron('0 0 30 2 *'), at('2026-01-01T00:00:00Z'))).toBeNull();
  });
});

describe('cronNextN', () => {
  it('returns consecutive occurrences', () => {
    expect(cronNextN(parseCron('0 2 * * *'), at('2026-07-02T00:00:00Z'), 3).map((d) => d.toISOString())).toEqual([
      '2026-07-02T02:00:00.000Z',
      '2026-07-03T02:00:00.000Z',
      '2026-07-04T02:00:00.000Z',
    ]);
  });

  it('stops early when there is no further occurrence', () => {
    expect(cronNextN(parseCron('0 0 30 2 *'), at('2026-01-01T00:00:00Z'), 3)).toEqual([]);
  });
});

describe('isJobDue — due selection', () => {
  const daily2 = parseCron('0 2 * * *');

  it('fires once the slot after lastRunAt has passed', () => {
    expect(isJobDue(daily2, at('2026-07-01T02:00:00Z'), at('2026-06-01T00:00:00Z'), at('2026-07-02T02:00:30Z'))).toBe(true);
  });

  it('does not fire before the next slot', () => {
    expect(isJobDue(daily2, at('2026-07-02T02:00:00Z'), at('2026-06-01T00:00:00Z'), at('2026-07-02T13:00:00Z'))).toBe(false);
  });

  it('anchors never-run jobs to createdAt (creation is not a fire)', () => {
    // Created 03:00 → today's 02:00 already passed → waits for tomorrow.
    expect(isJobDue(daily2, null, at('2026-07-02T03:00:00Z'), at('2026-07-02T12:00:00Z'))).toBe(false);
    expect(isJobDue(daily2, null, at('2026-07-02T03:00:00Z'), at('2026-07-03T02:00:00Z'))).toBe(true);
  });

  it('collapses many missed slots into one fire (catch-up safe)', () => {
    const now = at('2026-07-02T12:00:00Z');
    expect(isJobDue(daily2, at('2026-06-25T02:00:00Z'), at('2026-01-01T00:00:00Z'), now)).toBe(true);
    // After firing (lastRunAt = now) it is quiet until the next slot.
    expect(isJobDue(daily2, now, at('2026-01-01T00:00:00Z'), now)).toBe(false);
  });

  it('a manual run just before the slot does not skip the slot', () => {
    expect(isJobDue(daily2, at('2026-07-02T01:30:00Z'), at('2026-01-01T00:00:00Z'), at('2026-07-02T02:00:10Z'))).toBe(true);
  });
});

describe('describeCron', () => {
  it('phrases the preset shapes', () => {
    expect(describeCron('0 2 * * *')).toBe('every day 02:00');
    expect(describeCron('0 * * * *')).toBe('every hour');
    expect(describeCron('30 * * * *')).toBe('every hour at :30');
    expect(describeCron('0 2 * * 1')).toBe('every Monday 02:00');
    expect(describeCron('0 9 * * 1-5')).toBe('every weekday 09:00');
    expect(describeCron('*/15 * * * *')).toBe('every 15 minutes');
    expect(describeCron('0 */6 * * *')).toBe('every 6 hours');
    expect(describeCron('* * * * *')).toBe('every minute');
    expect(describeCron('0 0 1 * *')).toBe('monthly on day 1 at 00:00');
    expect(describeCron('30 6 * * 2,4')).toBe('every Tuesday, Thursday 06:30');
  });

  it('falls back to the raw expression for exotic shapes and invalid input', () => {
    expect(describeCron('0 2 15 * 1')).toBe('0 2 15 * 1'); // dom+dow OR rule
    expect(describeCron('0 2 * 6 *')).toBe('0 2 * 6 *'); // month-restricted
    expect(describeCron('not a cron')).toBe('not a cron');
  });
});
