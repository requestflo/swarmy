import { describe, expect, it } from 'bun:test';
import type { WakeTimesView } from '@swarmy/core';
import { wakeWords } from './wake-words';

const none: WakeTimesView = { samples: 0, typicalMs: null, fastestMs: null, slowestMs: null, lastAt: null, lastMs: null };

describe('wakeWords', () => {
  it('says the typical wake', () => {
    const five = { ...none, samples: 5, typicalMs: 2_140, fastestMs: 1_800, slowestMs: 4_000, lastMs: 2_000, lastAt: new Date(0).toISOString() };
    expect(wakeWords(five, 'shop.example.com')).toBe('Wakes in about 2.1 s (the middle of its last 5 wakes).');
    expect(wakeWords({ ...none, samples: 1, typicalMs: 6_000 }, null)).toBe('Wakes in about 6 s (its one wake so far).');
  });

  it('never makes a number up before the first wake', () => {
    expect(wakeWords(none, 'shop.example.com')).toBe('swarmy hasn’t timed a wake yet: the next visit to shop.example.com that finds it asleep will be.');
    expect(wakeWords(undefined, null)).toBeNull();
  });
});
