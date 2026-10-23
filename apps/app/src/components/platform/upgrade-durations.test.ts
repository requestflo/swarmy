import { describe, expect, it } from 'bun:test';
import { durationOf, fmtDuration, stepDurations, stepTimeWords } from './upgrade-durations';

const T0 = Date.parse('2026-10-23T02:00:00Z');
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();

describe('fmtDuration', () => {
  it('reads like the board', () => {
    expect(fmtDuration(4_200)).toBe('4 s');
    expect(fmtDuration(64_000)).toBe('1 min 04 s');
    expect(fmtDuration(372_000)).toBe('6 min 12 s');
    expect(fmtDuration(3_720_000)).toBe('1 h 02 min');
  });
});

describe('durationOf / stepTimeWords', () => {
  it('a finished step took its span; a running one counts up', () => {
    expect(stepTimeWords({ startedAt: iso(0), finishedAt: iso(38) })).toBe('took 38 s');
    expect(stepTimeWords({ startedAt: iso(0), finishedAt: null }, T0 + 12_000)).toBe('12 s so far');
  });
  it('never started, or a backwards clock, says nothing', () => {
    expect(stepTimeWords({ startedAt: null, finishedAt: null })).toBe('');
    expect(durationOf({ startedAt: iso(10), finishedAt: iso(0) })).toBeNull();
  });
});

describe('stepDurations', () => {
  it('lists done steps only, in order', () => {
    const steps = [
      { key: 'preflight', status: 'done', startedAt: iso(0), finishedAt: iso(4) },
      { key: 'engines', status: 'skipped', startedAt: iso(4), finishedAt: iso(4) },
      { key: 'verify', status: 'running', startedAt: iso(4), finishedAt: null },
    ];
    expect(stepDurations(steps)).toEqual([{ key: 'preflight', ms: 4000 }]);
  });
});
