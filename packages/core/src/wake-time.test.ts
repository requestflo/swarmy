import { describe, expect, it } from 'bun:test';
import { WAKE_SAMPLES_KEPT, keepWakeSamples, wakeSpanWords, wakeTimesView, type WakeSample } from './wake-time';

describe('wakeTimesView', () => {
  it('says nothing without a measured wake', () => {
    expect(wakeTimesView([])).toEqual({ samples: 0, typicalMs: null, fastestMs: null, slowestMs: null, lastAt: null, lastMs: null });
  });

  it('the typical wake is the median, so one slow cold pull does not skew it', () => {
    const s: WakeSample[] = [
      { at: 1_000, ms: 2_100 },
      { at: 3_000, ms: 31_000 },
      { at: 2_000, ms: 1_900 },
    ];
    const v = wakeTimesView(s);
    expect(v.typicalMs).toBe(2_100);
    expect(v.fastestMs).toBe(1_900);
    expect(v.slowestMs).toBe(31_000);
    expect(v.lastMs).toBe(31_000);
    expect(v.lastAt).toBe(new Date(3_000).toISOString());
  });

  it('an even count takes the middle two', () => {
    expect(wakeTimesView([{ at: 1, ms: 2_000 }, { at: 2, ms: 3_000 }]).typicalMs).toBe(2_500);
  });
});

describe('keepWakeSamples', () => {
  it('keeps the newest ones, oldest first', () => {
    let kept: WakeSample[] = [];
    for (let i = 0; i < WAKE_SAMPLES_KEPT + 5; i++) kept = keepWakeSamples(kept, { at: i, ms: 1_000 + i });
    expect(kept).toHaveLength(WAKE_SAMPLES_KEPT);
    expect(kept[0]!.at).toBe(5);
    expect(kept.at(-1)!.at).toBe(WAKE_SAMPLES_KEPT + 4);
  });
});

describe('wakeSpanWords', () => {
  it('says a wake the way the Scaling page does', () => {
    expect(wakeSpanWords(2_140)).toBe('2.1 s');
    expect(wakeSpanWords(40)).toBe('0.1 s');
    expect(wakeSpanWords(14_400)).toBe('14 s');
    expect(wakeSpanWords(65_000)).toBe('1 min 5 s');
    expect(wakeSpanWords(120_000)).toBe('2 min');
  });
});
