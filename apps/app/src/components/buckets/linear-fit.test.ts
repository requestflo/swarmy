import { describe, expect, it } from 'bun:test';
import { linearFit, nextMilestone } from './linear-fit';

const MB = 1024 * 1024;
const GB = 1024 * MB;

describe('linearFit', () => {
  it('a perfect line: its slope and intercept, R² 1', () => {
    const f = linearFit([0, 1, 2, 3].map((x) => ({ x, y: 10 + 3 * x })))!;
    expect([f.slope, f.intercept, f.r2, f.n]).toEqual([3, 10, 1, 4]);
  });

  it('noise around a line lowers R²; pure noise has none to speak of', () => {
    const noisy = linearFit([0, 1, 2, 3, 4, 5].map((x) => ({ x, y: 2 * x + (x % 2 ? 6 : -6) })))!;
    expect(noisy.slope).toBeCloseTo(3.03, 2);
    expect(noisy.r2).toBeCloseTo(0.448, 3);
    const zigzag = linearFit([0, 1, 2, 3].map((x) => ({ x, y: x % 2 ? 5 : 0 })))!;
    expect(zigzag.r2).toBeLessThan(0.25);
  });

  it('a flat series fits exactly with slope 0', () => {
    expect(linearFit([0, 1, 2].map((x) => ({ x, y: 7 }))))!.toEqual({ slope: 0, intercept: 7, r2: 1, n: 3 });
  });

  it('nothing to fit: under two points, or every reading at one moment', () => {
    expect(linearFit([])).toBeNull();
    expect(linearFit([{ x: 1, y: 1 }])).toBeNull();
    expect(linearFit([{ x: 1, y: 1 }, { x: 1, y: 9 }])).toBeNull();
  });
});

describe('nextMilestone', () => {
  it('the first 1·2·5 size a quarter above today', () => {
    expect(nextMilestone(18.4 * GB)).toBe(50 * GB);
    expect(nextMilestone(70 * GB)).toBe(100 * GB);
    expect(nextMilestone(300 * MB)).toBe(500 * MB);
    expect(nextMilestone(450 * MB)).toBe(1 * GB);
    expect(nextMilestone(900 * GB)).toBe(1024 * 1024 * MB * 2);
    expect(nextMilestone(0)).toBe(MB);
  });
});
