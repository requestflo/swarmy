import { describe, expect, it } from 'bun:test';
import { estateUptimeFrom, uptimePct } from './estate-uptime';

const status = (slots: number, downSlots = 0) => ({ slots, downSlots, slotMinutes: 1 });
const edges = (slots: number, downSlots = 0) => ({ slots, downSlots, slotMinutes: 5 });
const MONTH_MIN = 30 * 24 * 60;

describe('uptimePct', () => {
  it('floors, so a single down slot never reads 100', () => {
    expect(uptimePct(MONTH_MIN, 13)).toBe(99.96);
    expect(uptimePct(MONTH_MIN, 1)).toBe(99.99);
    expect(uptimePct(MONTH_MIN, 0)).toBe(100);
  });

  it('clamps nonsense counts', () => {
    expect(uptimePct(10, 20)).toBe(0);
    expect(uptimePct(10, -1)).toBe(100);
    expect(uptimePct(0, 0)).toBe(0);
  });
});

describe('estateUptimeFrom', () => {
  it('uses the status checks when they cover at least a day', () => {
    expect(estateUptimeFrom(status(MONTH_MIN, 13), edges(2016, 1))).toEqual({
      state: 'ok', pct: 99.96, source: 'status-checks', windowDays: 30, coveredHours: 720, downMinutes: 13,
    });
  });

  it('falls back to the edges when the status checks are thin, saying how much they saw', () => {
    expect(estateUptimeFrom(status(600), edges(2016, 2))).toEqual({
      state: 'ok', pct: 99.9, source: 'edge-requests', windowDays: 30, coveredHours: 168, downMinutes: 10,
    });
  });

  it('never makes up 100%: not enough data when neither source has a day', () => {
    expect(estateUptimeFrom(status(600), edges(100))).toEqual({
      state: 'not-enough-data', pct: null, source: 'status-checks', windowDays: 30, coveredHours: 10, downMinutes: null,
    });
    expect(estateUptimeFrom(status(0), edges(0))).toEqual({
      state: 'not-enough-data', pct: null, source: null, windowDays: 30, coveredHours: 0, downMinutes: null,
    });
  });

  it('says 100 only when it saw enough and nothing was down', () => {
    expect(estateUptimeFrom(status(0), edges(288)).pct).toBe(100);
    expect(estateUptimeFrom(status(0), edges(287)).state).toBe('not-enough-data');
  });
});
