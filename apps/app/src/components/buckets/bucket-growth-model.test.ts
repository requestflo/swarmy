import { describe, expect, it } from 'bun:test';
import type { BucketSizeHistoryView } from '@swarmy/core';
import { bucketGrowth, fillWords, growthWords } from './bucket-growth-model';

const MB = 1024 * 1024;
const GB = 1024 * MB;
const FROM = '2026-10-17T13:00:00.000Z';

/** 168 hourly slots; `fill(i)` is the size at slot i (null = no reading). */
function view(fill: (i: number) => number | null): BucketSizeHistoryView {
  const bytes = Array.from({ length: 168 }, (_, i) => fill(i));
  return { from: FROM, stepSeconds: 3600, bytes, objects: bytes.map((b) => (b === null ? null : 1)) };
}
const perHour = (310 * MB) / 167;
const steady = view((i) => 18.4 * GB - 310 * MB + i * perHour);

describe('bucketGrowth', () => {
  it('a steady week: +310 MB this week, full at the trend', () => {
    const g = bucketGrowth(steady, 50 * GB);
    if (g.kind !== 'trend') throw new Error('expected a trend');
    expect(Math.round(g.weekBytes / MB)).toBe(310);
    expect(Math.round(g.spanDays * 10) / 10).toBe(7);
    expect(Math.round(g.perDayBytes / MB)).toBe(45);
    expect(Math.round(g.fullInDays! / 30.44)).toBe(24);
    expect(growthWords(g, true)).toEqual({ change: '+310 MB this week', forecast: 'full in ~24 months' });
  });

  it('under 3 days of readings says not enough history yet — no numbers', () => {
    const young = view((i) => (i < 168 - 60 ? null : GB + i * MB));
    const g = bucketGrowth(young, 50 * GB);
    expect(g.kind).toBe('not-enough');
    expect(growthWords(g, true)).toEqual({ change: 'not enough history yet', forecast: null });
    expect(bucketGrowth(view(() => null), 50 * GB).kind).toBe('not-enough');
  });

  it('gaps are skipped; 3 days of readings across a gap are enough', () => {
    const gappy = view((i) => (i >= 96 && i < 120 ? null : i < 90 ? null : GB + i * MB));
    expect(bucketGrowth(gappy, null).kind).toBe('trend');
  });

  it('a shrinking or flat bucket gets no fill date, and says why only when there is a limit', () => {
    const shrinking = bucketGrowth(view((i) => 10 * GB - i * MB), 50 * GB);
    expect(shrinking.kind === 'trend' && shrinking.fullInDays).toBeNull();
    expect(growthWords(shrinking, true)).toEqual({ change: '−167 MB this week', forecast: 'not filling up' });
    const flat = bucketGrowth(view(() => 5 * GB), null);
    expect(growthWords(flat, false)).toEqual({ change: 'no change this week', forecast: null });
  });

  it('growing with no limit: the change, no forecast; over the limit: at the limit now', () => {
    expect(growthWords(bucketGrowth(steady, null), false)).toEqual({ change: '+310 MB this week', forecast: null });
    expect(growthWords(bucketGrowth(steady, 10 * GB), true).forecast).toBe('at the limit now');
  });
});

describe('fillWords', () => {
  it('days, weeks, months, years', () => {
    expect([fillWords(0.5), fillWords(5), fillWords(30), fillWords(600), fillWords(2000)]).toEqual([
      'within a day',
      '~5 days',
      '~4 weeks',
      '~20 months',
      '~5 years',
    ]);
  });
});
