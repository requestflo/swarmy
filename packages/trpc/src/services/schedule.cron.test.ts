import { describe, expect, it } from 'bun:test';
import { cronMatches, cronNext, cronPrev, isCronDue, parseCron } from './schedule';

const at = (iso: string): Date => new Date(iso);

describe('parseCron', () => {
  it('parses a full wildcard expression', () => {
    const spec = parseCron('* * * * *');
    expect(spec.minutes.size).toBe(60);
    expect(spec.hours.size).toBe(24);
    expect(spec.daysOfMonth.size).toBe(31);
    expect(spec.months.size).toBe(12);
    expect(spec.daysOfWeek.size).toBe(7);
    expect(spec.domRestricted).toBe(false);
    expect(spec.dowRestricted).toBe(false);
  });

  it('parses lists, ranges, and steps', () => {
    const spec = parseCron('0,30 9-17 */10 1,6 1-5');
    expect([...spec.minutes].sort((a, b) => a - b)).toEqual([0, 30]);
    expect(spec.hours.has(9)).toBe(true);
    expect(spec.hours.has(17)).toBe(true);
    expect(spec.hours.has(18)).toBe(false);
    expect([...spec.daysOfMonth].sort((a, b) => a - b)).toEqual([1, 11, 21, 31]);
    expect([...spec.months].sort((a, b) => a - b)).toEqual([1, 6]);
    expect([...spec.daysOfWeek].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('normalizes day-of-week 7 to Sunday (0)', () => {
    const spec = parseCron('0 3 * * 7');
    expect(spec.daysOfWeek.has(0)).toBe(true);
    expect(spec.daysOfWeek.has(7)).toBe(false);
  });

  it('rejects malformed expressions', () => {
    expect(() => parseCron('0 3 * *')).toThrow(); // 4 fields
    expect(() => parseCron('60 * * * *')).toThrow(); // minute out of range
    expect(() => parseCron('* 24 * * *')).toThrow(); // hour out of range
    expect(() => parseCron('* * 0 * *')).toThrow(); // dom below range
    expect(() => parseCron('* * * 13 *')).toThrow(); // month out of range
    expect(() => parseCron('*/0 * * * *')).toThrow(); // zero step
    expect(() => parseCron('5-1 * * * *')).toThrow(); // inverted range
    expect(() => parseCron('a * * * *')).toThrow(); // garbage
  });
});

describe('cronMatches', () => {
  it('matches minute/hour/month exactly (UTC)', () => {
    const spec = parseCron('30 14 * 6 *');
    expect(cronMatches(spec, at('2026-06-15T14:30:00Z'))).toBe(true);
    expect(cronMatches(spec, at('2026-06-15T14:31:00Z'))).toBe(false);
    expect(cronMatches(spec, at('2026-07-15T14:30:00Z'))).toBe(false);
  });

  it('applies the OR rule when both dom and dow are restricted', () => {
    // 2026-06-01 is a Monday (dow 1); the 15th is not a Monday.
    const spec = parseCron('0 0 15 * 1');
    expect(cronMatches(spec, at('2026-06-15T00:00:00Z'))).toBe(true); // dom hits
    expect(cronMatches(spec, at('2026-06-01T00:00:00Z'))).toBe(true); // dow hits
    expect(cronMatches(spec, at('2026-06-02T00:00:00Z'))).toBe(false); // neither
  });

  it('ANDs dom when only dom is restricted', () => {
    const spec = parseCron('0 0 15 * *');
    expect(cronMatches(spec, at('2026-06-15T00:00:00Z'))).toBe(true);
    expect(cronMatches(spec, at('2026-06-14T00:00:00Z'))).toBe(false);
  });
});

describe('cronNext / cronPrev', () => {
  it('finds the next occurrence strictly after `from`', () => {
    const spec = parseCron('0 */6 * * *');
    expect(cronNext(spec, at('2026-06-27T05:59:00Z'))?.toISOString()).toBe(
      '2026-06-27T06:00:00.000Z',
    );
    // Exactly on a slot → strictly after → the following slot.
    expect(cronNext(spec, at('2026-06-27T06:00:00Z'))?.toISOString()).toBe(
      '2026-06-27T12:00:00.000Z',
    );
  });

  it('finds the most recent occurrence at-or-before `from`', () => {
    const spec = parseCron('0 3 * * *');
    expect(cronPrev(spec, at('2026-06-27T02:59:00Z'))?.toISOString()).toBe(
      '2026-06-26T03:00:00.000Z',
    );
    // Exactly on a slot → inclusive.
    expect(cronPrev(spec, at('2026-06-27T03:00:30Z'))?.toISOString()).toBe(
      '2026-06-27T03:00:00.000Z',
    );
  });

  it('crosses month boundaries', () => {
    const spec = parseCron('0 0 1 * *');
    expect(cronNext(spec, at('2026-06-15T00:00:00Z'))?.toISOString()).toBe(
      '2026-07-01T00:00:00.000Z',
    );
  });
});

describe('isCronDue', () => {
  const nightly = parseCron('0 3 * * *');

  it('is due when the last run predates the latest occurrence', () => {
    expect(isCronDue(nightly, at('2026-06-26T03:00:00Z'), at('2026-06-27T03:05:00Z'))).toBe(true);
  });

  it('is not due when the latest occurrence already ran', () => {
    expect(isCronDue(nightly, at('2026-06-27T03:00:10Z'), at('2026-06-27T09:00:00Z'))).toBe(false);
  });

  it('is due for a never-run schedule once an occurrence has passed', () => {
    expect(isCronDue(nightly, null, at('2026-06-27T12:00:00Z'))).toBe(true);
  });

  it('collapses many missed slots into a single due run (catch-up safe)', () => {
    // Last ran a week ago; due exactly once now, and not again after running.
    const now = at('2026-06-27T10:00:00Z');
    expect(isCronDue(nightly, at('2026-06-20T03:00:00Z'), now)).toBe(true);
    expect(isCronDue(nightly, at('2026-06-27T03:00:00Z'), now)).toBe(false);
  });
});
