import { describe, expect, test } from 'bun:test';
import { approxCount, writesWords } from './time-travel-writes';

describe('rows written since', () => {
  test('approximate counts', () => {
    expect([40, 1_234, 12_480, 999_999, 3_400_000].map(approxCount)).toEqual(['~40', '~1.2k', '~12k', '~1M', '~3.4M']);
  });

  test('a count, none, or the restart caveat', () => {
    expect(writesWords({ status: 'counted', rows: 12_480 })).toBe('~12k rows changed since this save.');
    expect(writesWords({ status: 'counted', rows: 0 })).toBe('No rows changed since this save.');
    expect(writesWords({ status: 'reset' })).toBe('Rows changed since this save: unknown. The database restarted after it, so its count started again.');
  });
});
