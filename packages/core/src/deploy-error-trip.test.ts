import { describe, expect, it } from 'bun:test';
import {
  decideErrorTrip,
  errorTripThrough,
  errorTripWatchSec,
  errorTripWords,
  parseErrorTripPct,
  type AppMinute,
} from './deploy-error-trip';

const MIN = 60_000;
/** The deploy starts 20 s into minute 100. */
const T0 = 100 * MIN;
const DEPLOYED = T0 + 20_000;

/** `n` minutes starting at minute `from` (relative to T0), each with `req` requests and `err` errors. */
function minutes(from: number, n: number, req: number, err: number): AppMinute[] {
  return Array.from({ length: n }, (_, i) => ({ t: T0 + (from + i) * MIN, requests: req, errors5xx: err }));
}

/** 30 calm minutes before the deploy: 1000 requests a minute, 4 errors (0.4%). */
const CALM = minutes(-30, 30, 1000, 4);

describe('parseErrorTripPct (the label field)', () => {
  it('is on at 2% when the label does not say, off when it says null or false', () => {
    expect(parseErrorTripPct(undefined)).toBe(2);
    expect(parseErrorTripPct(null)).toBeNull();
    expect(parseErrorTripPct(false)).toBeNull();
    expect(parseErrorTripPct(0)).toBeNull();
    expect(parseErrorTripPct('junk')).toBeNull();
  });
  it('takes a floor and clamps it to 0.5–50', () => {
    expect(parseErrorTripPct(5)).toBe(5);
    expect(parseErrorTripPct(0.1)).toBe(0.5);
    expect(parseErrorTripPct(90)).toBe(50);
  });
});

describe('decideErrorTrip', () => {
  it('trips after two full minutes above 3× the baseline and the floor', () => {
    const d = decideErrorTrip({ minutes: [...CALM, ...minutes(1, 2, 1000, 70)], deployedAt: DEPLOYED, now: T0 + 3 * MIN + 31_000, floorPct: 2 });
    expect(d.baselinePct).toBeCloseTo(0.4);
    expect(d.thresholdPct).toBe(2);
    expect(d.trip).toBe(true);
    expect(d.failedPct).toBeCloseTo(7);
    expect(errorTripWords(d)).toBe('Stopped: 7% of requests failed, up from 0.4%');
  });

  it('does not judge a minute before its grace has passed', () => {
    const d = decideErrorTrip({ minutes: [...CALM, ...minutes(1, 2, 1000, 70)], deployedAt: DEPLOYED, now: T0 + 3 * MIN + 10_000, floorPct: 2 });
    expect(d.trip).toBe(false);
    expect(d.judgedThrough).toBe(T0 + MIN);
  });

  it('never counts the deploy’s own minute (old and new copies mixed)', () => {
    const d = decideErrorTrip({ minutes: [...CALM, ...minutes(0, 2, 1000, 90)], deployedAt: DEPLOYED, now: T0 + 2 * MIN + 31_000, floorPct: 2 });
    expect(d.trip).toBe(false);
  });

  it('needs the minutes in a row: one bad minute between calm ones never trips', () => {
    const bumpy = [...minutes(1, 1, 1000, 70), ...minutes(2, 1, 1000, 3), ...minutes(3, 1, 1000, 70)];
    const d = decideErrorTrip({ minutes: [...CALM, ...bumpy], deployedAt: DEPLOYED, now: T0 + 4 * MIN + 31_000, floorPct: 2 });
    expect(d.trip).toBe(false);
  });

  it('holds the line at 3× a noisy baseline', () => {
    // Before: 2% failing. After: 5% — above the 2% floor, below 3× 2% = 6%.
    const noisy = minutes(-30, 30, 1000, 20);
    const d = decideErrorTrip({ minutes: [...noisy, ...minutes(1, 3, 1000, 50)], deployedAt: DEPLOYED, now: T0 + 4 * MIN + 31_000, floorPct: 2 });
    expect(d.thresholdPct).toBeCloseTo(6);
    expect(d.trip).toBe(false);
  });

  it('a quiet app never trips on one error', () => {
    const quiet = minutes(1, 5, 3, 1); // 33% failing, but 3 requests a minute
    const d = decideErrorTrip({ minutes: quiet, deployedAt: DEPLOYED, now: T0 + 6 * MIN + 31_000, floorPct: 2 });
    expect(d.trip).toBe(false);
  });

  it('with too little traffic before, the floor alone is the line', () => {
    const d = decideErrorTrip({ minutes: [...minutes(-5, 5, 5, 0), ...minutes(1, 2, 100, 5)], deployedAt: DEPLOYED, now: T0 + 3 * MIN + 31_000, floorPct: 2 });
    expect(d.baselinePct).toBeNull();
    expect(d.trip).toBe(true);
    expect(errorTripWords(d)).toBe('Stopped: 5% of requests failed, above the 2% line');
  });

  it('sums cells of the same minute (several edges, several hosts)', () => {
    const split = [...minutes(1, 2, 500, 35), ...minutes(1, 2, 500, 35)];
    const d = decideErrorTrip({ minutes: [...CALM, ...split], deployedAt: DEPLOYED, now: T0 + 3 * MIN + 31_000, floorPct: 5 });
    expect(d.trip).toBe(true);
    expect(d.failedPct).toBeCloseTo(7);
  });
});

describe('the watch and the signature', () => {
  it('watches at least four minutes so two full minutes fit', () => {
    expect(errorTripWatchSec()).toBe(240);
  });
  it('the signature only moves once a minute', () => {
    expect(errorTripThrough(T0 + 2 * MIN + 31_000)).toBe(T0 + MIN);
    expect(errorTripThrough(T0 + 2 * MIN + 59_000)).toBe(T0 + MIN);
    expect(errorTripThrough(T0 + 3 * MIN + 31_000)).toBe(T0 + 2 * MIN);
  });
});
