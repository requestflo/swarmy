import { describe, expect, test } from 'bun:test';
import { backtest, coarsen, envelope, errorRateValues, gridEndingAt, type BacktestGrid } from './rule-backtest';

const MIN = 60_000;
const grid: BacktestGrid = { from: 0, stepMs: 5 * MIN, slots: 12 };
const series = (...v: Array<number | null>) => [...v, ...new Array<number | null>(grid.slots - v.length).fill(null)];

describe('backtest', () => {
  // 1 slot at 6% · calm · 3 slots at 7–9% · calm · 2 slots at 4% · … · open run at the end.
  const checkout = { name: 'storefront / checkout', values: [6, 1, 7, 9, 8, 1, 4, 4, 1, 1, 6.2, 6.4] };

  test('every crossing fires when the duration is shorter than a slot', () => {
    const r = backtest([checkout], grid, 5, 60);
    expect(r.fires.map((f) => [f.start / MIN, f.end / MIN, f.open])).toEqual([
      [0, 5, false],
      [10, 25, false],
      [50, 60, true],
    ]);
    expect(r.fires[1]?.peak).toBe(9);
    expect(r.blips).toBe(0);
  });

  test('the for-duration ignores shorter crossings and counts them as blips', () => {
    const r = backtest([checkout], grid, 5, 900);
    expect(r.fires.map((f) => f.start / MIN)).toEqual([10]);
    expect(r.blips).toBe(2);
  });

  test('strictly above the threshold, a lower line catches more, and no threshold fires nothing', () => {
    expect(backtest([checkout], grid, 6.4, 0).fires.map((f) => f.peak)).toEqual([9]);
    expect(backtest([checkout], grid, 3, 300).fires.length).toBe(4);
    expect(backtest([checkout], grid, null, 0).fires).toEqual([]);
  });

  test('a gap ends a run, and each subject fires on its own', () => {
    const gappy = { name: 'wkr-1', values: series(90, null, 90) };
    const other = { name: 'london-2', values: series(null, 91) };
    const r = backtest([gappy, other], grid, 85, 0);
    expect(r.fires.map((f) => `${f.subject}@${f.start / MIN}`)).toEqual(['wkr-1@0', 'london-2@5', 'wkr-1@10']);
  });
});

test('envelope keeps the highest reading per slot and null where nobody read', () => {
  expect(envelope([{ name: 'a', values: [1, null, 3] }, { name: 'b', values: [2, null, null] }], 3)).toEqual([2, null, 3]);
});

test('coarsen keeps the highest reading of each group', () => {
  expect(coarsen([1, 4, null, null, 2], 2)).toEqual([4, null, 2]);
});

test('gridEndingAt ends with the slot that holds now', () => {
  const g = gridEndingAt(Date.UTC(2026, 9, 23, 12, 7), 300);
  expect(g.slots).toBe(2016);
  expect(g.from + (g.slots - 1) * g.stepMs).toBe(Date.UTC(2026, 9, 23, 12, 5));
});

test('errorRateValues: % per slot, and fewer than 20 calls is no reading', () => {
  const g: BacktestGrid = { from: Date.UTC(2026, 9, 23, 12, 0), stepMs: 5 * MIN, slots: 3 };
  const v = errorRateValues(
    [
      { bucket: '2026-10-23 12:00:00', calls: 200, errors: 12 },
      { bucket: '2026-10-23 12:05:00', calls: 19, errors: 19 },
      { bucket: '2026-10-23 11:55:00', calls: 200, errors: 200 },
    ],
    g,
  );
  expect(v).toEqual([6, null, null]);
});
