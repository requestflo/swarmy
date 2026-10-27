import { describe, expect, test } from 'bun:test';
import { heatGrid, quietestSlot, windowSlots } from './traffic-heatmap-model';

// 2026-10-19 is a Monday.
const at = (day: number, hour: number) => Date.UTC(2026, 9, 19 + day, hour);

describe('windowSlots', () => {
  test('covers each two-hour slot the window touches, wrapping past midnight', () => {
    expect([...windowSlots({ days: [0], startHour: 3, hours: 2 })].sort()).toEqual(['0:1', '0:2']);
    expect([...windowSlots({ days: [6], startHour: 23, hours: 2 })].sort()).toEqual(['0:0', '6:11']);
  });
});

describe('heatGrid', () => {
  test('averages each slot, scales to the busiest, and leaves gaps as null', () => {
    const grid = heatGrid(
      [
        { t: at(0, 10), requestsPerMin: 100 },
        { t: at(0, 11), requestsPerMin: 300 },
        { t: at(0, 4), requestsPerMin: 20 },
        { t: at(0, 6), requestsPerMin: null },
      ],
      { days: [1], startHour: 4, hours: 2 },
    );
    const mon = grid[0]!;
    expect(mon[5]).toEqual({ rate: 200, level: 1, inWindow: false });
    expect(mon[2]).toEqual({ rate: 20, level: 0.1, inWindow: true });
    expect(mon[3]!.level).toBeNull();
    expect(grid[6]![2]!.inWindow).toBe(false);
    expect(quietestSlot(grid)).toBe('Mon 04:00–06:00 UTC');
  });

  test('four weeks: each slot averages the same weekday and hours across weeks', () => {
    const grid = heatGrid(
      [0, 7, 14, 21].map((d, i) => ({ t: at(d, 10), requestsPerMin: 100 * (i + 1) })),
      { days: [], startHour: 0, hours: 1 },
    );
    expect(grid[0]![5]).toEqual({ rate: 250, level: 1, inWindow: false });
  });

  test('no data, no quietest slot', () => {
    expect(quietestSlot(heatGrid([], { days: [], startHour: 0, hours: 1 }))).toBeNull();
  });
});
