import { describe, expect, it } from 'bun:test';
import { biggestDrop, dropSince, releaseSplits, stepCounts, stepVisitors } from './funnel-math';
import type { FunnelRow } from './funnel-query';

/** units that reached exactly `level` steps of a 4-step funnel under `release`. */
const row = (release: string, level: number, units: number): FunnelRow => ({ release, level, units: String(units) });

describe('funnel arithmetic', () => {
  it('visitors at step k are the units at level ≥ k', () => {
    const rows = [row('', 1, 40), row('', 2, 30), row('', 3, 20), row('', 4, 10)];
    expect(stepVisitors(rows, 4)).toEqual([100, 60, 30, 10]);
    const c = stepCounts([100, 60, 30, 10]);
    expect(c.map((s) => s.conversion)).toEqual([1, 0.6, 0.5, 1 / 3]);
    expect(c[0]!.dropOff).toBe(0);
  });

  it('the biggest drop is the largest share lost, never off a tiny step', () => {
    expect(biggestDrop([100, 60, 30, 10])).toEqual({ index: 3, dropOff: 2 / 3, lost: 20 });
    expect(biggestDrop([100, 60, 5, 0])).toEqual({ index: 2, dropOff: 55 / 60, lost: 55 });
    expect(biggestDrop([5, 1])).toBeNull();
    expect(biggestDrop([50, 50])).toBeNull();
  });
});

describe('drop since a release', () => {
  const releases = [
    { id: 'r1', fromMs: 1_000 },
    { id: 'r2', fromMs: 2_000 },
    { id: 'r3', fromMs: 3_000 },
  ];
  // Drop at step 3 (checkout → paid): r1 and r2 convert 75%, r3 converts 40%.
  const rows = [
    row('r1', 2, 25), row('r1', 3, 75),
    row('r2', 2, 50), row('r2', 3, 150),
    row('r3', 2, 120), row('r3', 3, 80),
  ];
  const drop = { index: 2, dropOff: 0.5, lost: 1 };

  it('splits the drop per release', () => {
    expect(releaseSplits(rows, 3, drop)).toEqual([
      { releaseId: 'r1', entered: 100, reached: 100, converted: 75 },
      { releaseId: 'r2', entered: 200, reached: 200, converted: 150 },
      { releaseId: 'r3', entered: 200, reached: 200, converted: 80 },
    ]);
  });

  it('names the deploy since which conversion clearly fell', () => {
    const since = dropSince(releaseSplits(rows, 3, drop), releases);
    expect(since).toEqual({ releaseId: 'r3', before: 0.75, after: 0.4 });
  });

  it('says nothing when the change is small, noisy or one-sided', () => {
    const flat = [row('r1', 2, 25), row('r1', 3, 75), row('r2', 2, 27), row('r2', 3, 73)];
    expect(dropSince(releaseSplits(flat, 3, drop), releases)).toBeNull();
    const thin = [row('r1', 2, 2), row('r1', 3, 8), row('r2', 2, 8), row('r2', 3, 2)];
    expect(dropSince(releaseSplits(thin, 3, drop), releases)).toBeNull();
    const better = [row('r1', 2, 60), row('r1', 3, 40), row('r2', 2, 10), row('r2', 3, 90)];
    expect(dropSince(releaseSplits(better, 3, drop), releases)).toBeNull();
    expect(dropSince(releaseSplits([row('r1', 2, 50), row('r1', 3, 50)], 3, drop), releases)).toBeNull();
  });
});
