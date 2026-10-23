import { describe, expect, test } from 'bun:test';
import type { ReleaseView } from '@swarmy/core';
import { catchReleases, gapWords, receiptWords, shippedVersions } from './catch-model';

const STEP = 300_000;
const grid = { from: 0, stepMs: STEP, slots: 100 };
const calm = (): Array<number | null> => Array.from({ length: 100 }, () => 0.3);
const when = (t: number): string => `t${t / STEP}`;

describe('would a canary have caught it', () => {
  test('a crossing inside the watch window is caught; a later one is a miss', () => {
    const v = calm();
    v[11] = 6; // 5 min after the release at slot 10
    v[60] = 8; // hours later
    const r = catchReleases(v, grid, [{ at: 10 * STEP, label: 'v1.9.0' }], 3, 15);
    expect(r.crossings.map((c) => [c.after?.label, c.caught])).toEqual([
      ['v1.9.0', true],
      ['v1.9.0', false],
    ]);
    expect(r.peak).toEqual({ v: 8, at: 60 * STEP });
    const words = receiptWords(r, 3, 15, when);
    expect(words).toContain('put back v1.9.0 (t11, 6% errors)');
    expect(words).toContain('on t60 (8%), 4 hours after v1.9.0 went out');
  });

  test('a higher trip lets a small spike through', () => {
    const v = calm();
    v[11] = 2.6;
    const r = catchReleases(v, grid, [{ at: 10 * STEP, label: 'v2' }], 3, 15);
    expect(r.crossings).toEqual([]);
    expect(receiptWords(r, 3, 15, when)).toBe('Errors never passed 3% this week (the worst was 2.6%, t11), so there was nothing to put back.');
  });

  test('a release mid-slot still owns the slot that holds it', () => {
    const v = calm();
    v[10] = 5;
    const r = catchReleases(v, grid, [{ at: 10 * STEP + 120_000, label: 'v3' }], 3, 15);
    expect(r.crossings[0]?.caught).toBe(true);
  });

  test('each release names the part’s own image', () => {
    const rel = (createdAt: string, web: string): ReleaseView =>
      ({ id: createdAt, stackName: 's', status: 'healthy', images: [{ name: 'api', image: 'x/api:9' }, { name: 'web', image: `x/web:${web}` }], actor: null, strategy: null, healthGate: null, notes: null, createdAt }) as ReleaseView;
    const s = shippedVersions([rel('2026-10-02T00:00:00Z', '1.9.0'), rel('2026-10-01T00:00:00Z', '1.8.3')], 'web');
    expect(s.map((x) => x.label)).toEqual(['v1.8.3', 'v1.9.0']);
  });

  test('gaps', () => {
    expect(gapWords(40 * 60_000)).toBe('40 min');
    expect(gapWords(26 * 3_600_000)).toBe('26 hours');
    expect(gapWords(50 * 3_600_000)).toBe('2 days');
  });
});
