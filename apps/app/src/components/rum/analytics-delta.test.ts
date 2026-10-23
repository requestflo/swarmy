import { describe, expect, test } from 'bun:test';
import { kpiDelta, signedPct, signedPts, versus } from './analytics-delta';

const k = (visits: number, pageviews: number, bounceRate: number) => ({
  visits,
  pageviews,
  bounceRate,
  medianVisitSeconds: 0,
  signedIn: 0,
});

describe('kpiDelta', () => {
  test('subtracts the current window from the double window', () => {
    const d = kpiDelta(k(28_750, 112_125, 0.38), k(55_870, 216_537, 0.3897));
    expect(d).not.toBeNull();
    expect(signedPct(d!.visits)).toBe('+6%');
    expect(signedPct(d!.pageviews!)).toBe('+7%');
    expect(signedPts(d!.bouncePts)).toBe('−2 pts');
  });

  test('says nothing when the earlier window is empty', () => {
    expect(kpiDelta(k(100, 400, 0.4), k(100, 400, 0.4))).toBeNull();
    expect(kpiDelta(k(0, 0, 0), k(0, 0, 0))).toBeNull();
  });

  test('leaves pageviews out when the earlier window had none', () => {
    expect(kpiDelta(k(10, 40, 0.5), k(12, 40, 0.5))?.pageviews).toBeNull();
  });
});

describe('formatting', () => {
  test('signs and rounds', () => {
    expect(signedPct(-0.004)).toBe('±0%');
    expect(signedPct(-0.12)).toBe('−12%');
    expect(signedPts(3.4)).toBe('+3 pts');
    expect(versus(7)).toBe('vs last week');
    expect(versus(30)).toBe('vs previous 30 days');
  });
});
