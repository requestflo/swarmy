import { describe, expect, it } from 'bun:test';
import type { AppMinute } from '@swarmy/core';
import { errorTripCheck, forgetErrorTrips } from './deploy-error-trip';
import { failureNotes, gateOf } from './deploy-gate.core';

const MIN = 60_000;
const T0 = 1_000 * MIN;
const release = { id: 'rel-1', createdAt: new Date(T0 + 20_000) };

/** 30 calm minutes before (0.4%), then `bad` minutes at 7% after the deploy. */
function series(bad: number): AppMinute[] {
  const before = Array.from({ length: 30 }, (_, i) => ({ t: T0 - (30 - i) * MIN, requests: 1000, errors5xx: 4 }));
  const after = Array.from({ length: bad }, (_, i) => ({ t: T0 + (i + 1) * MIN, requests: 1000, errors5xx: 70 }));
  return [...before, ...after];
}

describe('errorTripCheck', () => {
  it('trips in plain words once two full minutes are bad', () => {
    forgetErrorTrips(new Set());
    const reads: number[] = [];
    const read = (from: number): AppMinute[] => (reads.push(from), series(2));
    expect(errorTripCheck(read, release, 2, T0 + 3 * MIN + 31_000)).toBe('7% of requests failed, up from 0.4%');
    // The read starts 30 minutes before the deploy's minute: the baseline.
    expect(reads).toEqual([T0 - 30 * MIN]);
  });

  it('is signature-gated: a second look inside the same minute reads nothing', () => {
    forgetErrorTrips(new Set());
    let reads = 0;
    const read = (): AppMinute[] => (reads++, series(1));
    expect(errorTripCheck(read, release, 2, T0 + 2 * MIN + 31_000)).toBeNull();
    expect(errorTripCheck(read, release, 2, T0 + 2 * MIN + 46_000)).toBeNull();
    expect(reads).toBe(1);
    // The next complete minute is a new look.
    expect(errorTripCheck(() => series(2), release, 2, T0 + 3 * MIN + 31_000)).toBe('7% of requests failed, up from 0.4%');
  });

  it('forgets releases it no longer watches', () => {
    forgetErrorTrips(new Set());
    let reads = 0;
    const read = (): AppMinute[] => (reads++, series(0));
    errorTripCheck(read, release, 2, T0 + 2 * MIN + 31_000);
    forgetErrorTrips(new Set(['someone-else']));
    errorTripCheck(read, release, 2, T0 + 2 * MIN + 40_000);
    expect(reads).toBe(2);
  });
});

describe('failureNotes (the release timeline line)', () => {
  it('says Stopped when it was put back, Failed when it was only marked', () => {
    const f = { by: 'errors' as const, reasons: '7% of requests failed, up from 0.4%' };
    expect(failureNotes(f, true)).toBe('Stopped: 7% of requests failed, up from 0.4%');
    expect(failureNotes(f, false)).toBe('Failed: 7% of requests failed, up from 0.4%');
    expect(failureNotes({ by: 'health', reasons: 'degraded' }, true)).toBe('Health gate failed: degraded');
  });
});

describe('gateOf (the gate a release was recorded with)', () => {
  it('carries the floor, and a release recorded before the trip has none', () => {
    expect(gateOf({ windowSec: 180, autoRollback: true, errorTripPct: 2 }).errorTripPct).toBe(2);
    expect(gateOf({ windowSec: 180, autoRollback: true, errorTripPct: null }).errorTripPct).toBeNull();
    expect(gateOf({ windowSec: 180, autoRollback: true }).errorTripPct).toBeNull();
  });
  it('an app with no safety label is never tripped', () => {
    expect(gateOf(null)).toEqual({ windowSec: 120, autoRollback: false, errorTripPct: null, configured: false });
  });
});
