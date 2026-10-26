import { describe, expect, it } from 'bun:test';
import type { BucketSizeHistoryView } from '@swarmy/core';
import { bucketGrowth, dayWords, growthUrgent, growthWords } from './bucket-growth-model';

const MB = 1024 * 1024;
const GB = 1024 * MB;
const FROM = '2026-10-17T13:00:00.000Z';
const NOW = Date.parse('2026-10-24T12:30:00.000Z');

/** 168 hourly slots; `fill(i)` is the size at slot i (null = no reading). */
function view(fill: (i: number) => number | null): BucketSizeHistoryView {
  const bytes = Array.from({ length: 168 }, (_, i) => fill(i));
  return { from: FROM, stepSeconds: 3600, bytes, objects: bytes.map((b) => (b === null ? null : 1)) };
}
const perHour = (310 * MB) / 167;
const steady = view((i) => 18.4 * GB - 310 * MB + i * perHour);
const words = (h: BucketSizeHistoryView, limit: number | null) => growthWords(bucketGrowth(h, limit, undefined, NOW), NOW);

describe('bucketGrowth — a date only when the line means something', () => {
  it('a steady week: +310 MB, and the day it reaches its limit', () => {
    const g = bucketGrowth(steady, 50 * GB, undefined, NOW);
    expect(g.state).toBe('growing');
    expect(Math.round(g.perDayBytes / MB)).toBe(45);
    expect(g.r2).toBeCloseTo(1, 6);
    expect(words(steady, 50 * GB)).toEqual({ change: '+310 MB this week', forecast: 'At this rate it reaches its 50 GB limit around 19 Oct 2028.' });
    expect(growthUrgent(g, NOW)).toBe(false);
  });

  it('no limit: the next round size a quarter above today', () => {
    expect(words(steady, null).forecast).toBe('At this rate it reaches 50 GB around 19 Oct 2028.');
    const big = view((i) => 70 * GB + i * 50 * MB);
    expect(words(big, null).forecast).toBe('At this rate it reaches 100 GB around 12 Nov.');
  });

  it('close to the limit is urgent; over it says writes are refused', () => {
    const fast = view((i) => 38 * GB + (i * GB) / 24);
    const g = bucketGrowth(fast, 50 * GB, undefined, NOW);
    expect(growthWords(g, NOW).forecast).toBe('At this rate it reaches its 50 GB limit around 29 Oct.');
    expect(growthUrgent(g, NOW)).toBe(true);
    expect(words(steady, 10 * GB).forecast).toBe('It has reached its 10 GB limit: new writes are refused until the limit goes up.');
  });

  it('a date more than three years out is not given', () => {
    const slow = view((i) => 100 * GB + (i * 614 * MB) / 168);
    expect(words(slow, null).forecast).toBe('At this rate it stays under 200 GB for more than three years.');
  });

  it('under 3 days or 24 readings: not enough history, no numbers', () => {
    const young = view((i) => (i < 168 - 60 ? null : GB + i * MB));
    expect(words(young, 50 * GB)).toEqual({ change: null, forecast: 'Not enough history to forecast yet: a forecast needs 3 days of readings.' });
    const sparse = view((i) => (i % 12 === 0 ? GB + i * MB : null));
    expect(bucketGrowth(sparse, null, undefined, NOW).state).toBe('not-enough');
    expect(bucketGrowth(view(() => null), 50 * GB, undefined, NOW).state).toBe('not-enough');
  });

  it('flat: the same size, or growth under 0.5% a week', () => {
    expect(words(view(() => 5 * GB), 50 * GB)).toEqual({ change: 'no change this week', forecast: 'Growth is flat: it has stayed about the same size all week.' });
    expect(bucketGrowth(view((i) => 5 * GB + i * 10 * 1024), 50 * GB, undefined, NOW).state).toBe('flat');
  });

  it('shrinking says it isn’t filling up', () => {
    expect(words(view((i) => 10 * GB - i * MB), 50 * GB)).toEqual({ change: '−167 MB this week', forecast: 'It got smaller this week, so it isn’t filling up.' });
  });

  it('a big upload then a delete is uneven: no date', () => {
    const lumpy = view((i) => (i >= 70 && i < 150 ? 8 * GB : 5 * GB));
    const g = bucketGrowth(lumpy, 50 * GB, undefined, NOW);
    expect(g.state).toBe('uneven');
    expect(g.forecast).toBeNull();
  });

  it('gaps are skipped; 3 days of readings across a gap are enough', () => {
    const gappy = view((i) => (i >= 96 && i < 120 ? null : i < 90 ? null : GB + i * 10 * MB));
    expect(bucketGrowth(gappy, null, undefined, NOW).state).toBe('growing');
  });
});

describe('dayWords', () => {
  it('day and month this year, the year otherwise (UTC)', () => {
    expect(dayWords(Date.parse('2026-03-14T23:00:00Z'), NOW)).toBe('14 Mar');
    expect(dayWords(Date.parse('2027-03-14T01:00:00Z'), NOW)).toBe('14 Mar 2027');
  });
});
