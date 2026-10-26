import { describe, expect, test } from 'bun:test';
import { sizeAt, sizePath, sizeSeries } from './time-travel-sizes';
import { ago, H, NOW, save } from './time-travel-fixtures';

const sized = (id: string, msAgo: number, bytes: number, engine: Parameters<typeof save>[2] = 'pg_dump') => ({ ...save(id, msAgo, engine), sizeBytes: String(bytes) });

describe('sizeSeries', () => {
  test('a wal-g base backup’s data size wins over dump sizes', () => {
    const s = sizeSeries({
      cluster: 'main',
      saves: [sized('d1', 30 * H, 100)],
      baseBackups: [{ name: 'b2', finishTime: ago(10 * H), sizeBytes: '2000' }, { name: 'b1', finishTime: ago(40 * H), sizeBytes: '1800' }, { name: 'b0', finishTime: ago(50 * H) }],
      now: NOW,
    });
    expect(s?.measure).toBe('data');
    expect(s?.points.map((p) => p.bytes)).toEqual([1800, 2000]);
  });

  test('else the schedule’s dumps: the engine most saves used, never a pre-restore safety copy', () => {
    const safety = { ...sized('d4', 1 * H, 5000, 'pg_dump'), reason: 'pre-restore' };
    const s = sizeSeries({
      cluster: 'checkout',
      saves: [safety, sized('d3', 2 * H, 900, 'pg_dumpall'), sized('d2', 20 * H, 300, 'snapshot-from-replica'), sized('d1', 44 * H, 250)],
      now: NOW,
    });
    expect(s).toMatchObject({ measure: 'dump' });
    expect(s?.points.map((p) => p.bytes)).toEqual([250, 300]);
  });

  test('only the newest point before the week is carried in, at the left edge', () => {
    const s = sizeSeries({ cluster: 'c', saves: [sized('a', 9 * 24 * H, 10), sized('b', 8 * 24 * H, 20), sized('c', 24 * H, 30)], now: NOW })!;
    expect(s.points.map((p) => [p.bytes, p.pos])).toEqual([[20, 0], [30, s.points[1]!.pos]]);
    expect(sizeAt(s, NOW - 2 * 24 * H)?.bytes).toBe(20);
    expect(sizeAt(s, NOW)?.bytes).toBe(30);
    expect(sizeSeries({ cluster: 'c', saves: [], now: NOW })).toBeNull();
  });

  test('the step line holds each size until the next save, then to now', () => {
    const s = { cluster: 'c', measure: 'dump' as const, points: [{ at: 0, pos: 0, bytes: 10 }, { at: 1, pos: 0.5, bytes: 20 }] };
    expect(sizePath(s, 44)).toBe('0,38.0 500,38.0 500,6.0 1000,6.0');
  });
});
