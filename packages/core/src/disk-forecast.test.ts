import { describe, expect, it } from 'bun:test';
import { describeDiskForecast, diskForecastSeverity, forecastDiskFull, type DiskSample } from './disk-forecast';

const GB = 1024 ** 3;
const H = 3_600_000;
const NOW = 1_800_000_000_000;

/** One sample per hour for `hours`, ending at NOW. */
function series(hours: number, used: (h: number) => number, total = 100 * GB): DiskSample[] {
  return Array.from({ length: hours + 1 }, (_, i) => ({
    ts: NOW - (hours - i) * H,
    usedBytes: used(i),
    totalBytes: typeof total === 'number' ? total : total,
  }));
}

describe('forecastDiskFull', () => {
  it('steady growth → days to 85% and to full', () => {
    // 40 GB growing 1 GB/day for 3 days.
    const f = forecastDiskFull(series(72, (h) => 40 * GB + (h / 24) * GB), { now: NOW });
    expect(f.status).toBe('growing');
    expect(f.bytesPerDay / GB).toBeCloseTo(1, 5);
    expect(f.daysToPressure!).toBeCloseTo(85 - 43, 3);
    expect(f.daysToFull!).toBeCloseTo(57, 3);
    expect(f.r2).toBeCloseTo(1, 5);
    expect(diskForecastSeverity(f)).toBeNull();
    expect(describeDiskForecast(f)).toBe('43% full. At the current rate it fills up in about 57 days.');
  });

  it('fast growth → warning, then critical', () => {
    const warn = forecastDiskFull(series(48, (h) => 80 * GB + (h / 24) * 2 * GB), { now: NOW });
    expect(diskForecastSeverity(warn)).toBe('warning');
    const crit = forecastDiskFull(series(48, (h) => 90 * GB + (h / 24) * 3 * GB), { now: NOW });
    expect(diskForecastSeverity(crit)).toBe('critical');
  });

  it('flat usage is stable, not an alert', () => {
    const f = forecastDiskFull(series(72, (h) => 40 * GB + (h % 2) * 1024 ** 2), { now: NOW });
    expect(f.status).toBe('stable');
    expect(diskForecastSeverity(f)).toBeNull();
    expect(describeDiskForecast(f)).toBe('40% full and not growing.');
  });

  it('too little history → insufficient-data', () => {
    expect(forecastDiskFull(series(3, () => 50 * GB), { now: NOW }).status).toBe('insufficient-data');
    expect(forecastDiskFull([], { now: NOW }).status).toBe('insufficient-data');
  });

  it('a prune drop restarts the fit after it (no false "shrinking")', () => {
    // Grows 1 GB/day, then node-hygiene frees 20 GB at h=48, then keeps growing.
    const f = forecastDiskFull(
      series(96, (h) => (h < 48 ? 60 * GB + (h / 24) * GB : 42 * GB + ((h - 48) / 24) * GB)),
      { now: NOW },
    );
    expect(f.status).toBe('growing');
    expect(f.bytesPerDay / GB).toBeCloseTo(1, 5);
    expect(f.since).toBe(NOW - 48 * H);
  });

  it('an added/grown disk restarts the fit at the capacity change', () => {
    const s = series(96, (h) => 40 * GB + (h / 24) * 5 * GB).map((p, i) => ({
      ...p,
      totalBytes: i < 60 ? 100 * GB : 200 * GB,
    }));
    const f = forecastDiskFull(s, { now: NOW });
    expect(f.since).toBe(NOW - 36 * H);
    expect(f.totalBytes).toBe(200 * GB);
  });

  it('ignores samples outside the window and in the future', () => {
    const old = { ts: NOW - 30 * 24 * H, usedBytes: 1 * GB, totalBytes: 100 * GB };
    const future = { ts: NOW + H, usedBytes: 99 * GB, totalBytes: 100 * GB };
    const f = forecastDiskFull([old, future, ...series(24, (h) => 50 * GB + (h / 24) * GB)], { now: NOW });
    expect(f.samples).toBe(25);
  });

  it('full disk is critical', () => {
    const f = forecastDiskFull([{ ts: NOW, usedBytes: 100 * GB, totalBytes: 100 * GB }], { now: NOW });
    expect(f.status).toBe('full');
    expect(diskForecastSeverity(f)).toBe('critical');
  });
});
