import { describe, expect, it } from 'bun:test';
import { historyRows, pctPath } from './server-history-model';

describe('historyRows', () => {
  it('one row per metric with a reading, its peak, warm past the server`s own level', () => {
    const rows = historyRows({ nodeId: 'n', name: 'wkr-1', cpu: [12, null, 40], mem: [null, null, null], disk: [79, 80.6, null] });
    expect(rows.map((r) => [r.key, r.peak, r.hot])).toEqual([
      ['cpu', 40, false],
      ['disk', 80.6, true],
    ]);
  });
});

describe('pctPath', () => {
  it('draws on a fixed 0–100 scale and breaks the line at a gap', () => {
    expect(pctPath([0, 100, null, 50], 30, 12)).toBe('M0.0 11.0 L10.0 1.0 M30.0 6.0');
  });

  it('nothing to draw → empty path', () => {
    expect(pctPath([], 30, 12)).toBe('');
    expect(pctPath([null, null], 30, 12)).toBe('');
  });
});
