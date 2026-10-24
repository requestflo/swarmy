import { describe, expect, it } from 'bun:test';
import { addSeries, lastKnown, runsOf, seriesPath, slotStart, sumSince } from './history-model';

const grid = { from: '2026-10-24T00:00:00.000Z', stepSeconds: 900 };
const T0 = Date.parse(grid.from);

describe('history grid helpers', () => {
  it('slot i starts at from + i × step', () => {
    expect(slotStart(grid, 0)).toBe(T0);
    expect(slotStart(grid, 4)).toBe(T0 + 3_600_000);
  });

  it('lastKnown skips trailing gaps; none is null', () => {
    expect(lastKnown([1, 2, null, null])).toBe(2);
    expect(lastKnown([null, null])).toBeNull();
  });

  it('sumSince adds the slots from a moment on, and says when none was measured', () => {
    expect(sumSince(grid, [5, 7, null, 3], T0 + 900_000)).toEqual({ total: 10, measured: true });
    expect(sumSince(grid, [5, null, null], T0 + 900_000)).toEqual({ total: 0, measured: false });
  });

  it('addSeries sums slot by slot; a slot is null only when every input is', () => {
    expect(addSeries([[1, null, null], [2, 3, null]])).toEqual([3, 3, null]);
    expect(addSeries([])).toEqual([]);
  });
});

describe('seriesPath — gaps stay gaps', () => {
  it('splits runs at nulls', () => {
    expect(runsOf([1, 2, null, 4])).toEqual([[[0, 1], [1, 2]], [[3, 4]]]);
  });

  it('draws lines, staircases and closed areas on a 0..max scale', () => {
    // w 30 over 4 points → x = 0, 10, 20, 30; h 12 → y(v) = 11 - v/max × 10.
    expect(seriesPath([0, 10, null, 5], 30, 12, 10)).toBe('M0.0 11.0 L10.0 1.0 M30.0 6.0');
    expect(seriesPath([0, 10], 30, 12, 10, { step: true })).toBe('M0.0 11.0 H30.0 V1.0');
    expect(seriesPath([10, 10], 30, 12, 10, { closed: true })).toBe('M0.0 11.0 L0.0 1.0 L30.0 1.0 L30.0 11.0 Z');
  });

  it('a raised floor spreads a narrow band (a hit rate between 80 and 100%)', () => {
    expect(seriesPath([80, 90, 100], 30, 12, 100, { min: 80 })).toBe('M0.0 11.0 L15.0 6.0 L30.0 1.0');
    expect(seriesPath([50], 30, 12, 100, { min: 80 })).toBe('M0.0 11.0');
  });

  it('nothing to draw without readings or a scale', () => {
    expect(seriesPath([], 30, 12, 10)).toBe('');
    expect(seriesPath([1], 30, 12, 0)).toBe('');
  });
});
