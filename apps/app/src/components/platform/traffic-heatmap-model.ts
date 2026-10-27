/**
 * Pure: four weeks of edge traffic (`traffic.series` 28d, hourly buckets)
 * folded into a 7 × 12 grid of two-hour UTC slots — each slot the average of
 * every hour that falls in it — with the auto-patch window drawn over it, so
 * you can see the window sits in your quiet hours.
 */

export interface SeriesPoint {
  t: number;
  /** null = no edge reported (a gap, not a zero). */
  requestsPerMin: number | null;
}

export interface PatchWindow {
  /** 0 = Sunday … 6 = Saturday (UTC). */
  days: number[];
  startHour: number;
  hours: number;
}

export interface HeatCell {
  /** 0..1 of the busiest slot; null when no edge reported in it. */
  level: number | null;
  /** Average requests/min in the slot. */
  rate: number | null;
  inWindow: boolean;
}

/** Rows in reading order: Mon … Sun. */
export const ROW_DAYS = [1, 2, 3, 4, 5, 6, 0] as const;
export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const SLOTS = 12;

/** The (day, slot) pairs the window touches, wrapping past midnight. */
export function windowSlots(w: PatchWindow): Set<string> {
  const out = new Set<string>();
  for (const d of w.days) {
    for (let h = w.startHour; h < w.startHour + w.hours; h++) {
      out.add(`${(d + Math.floor(h / 24)) % 7}:${Math.floor((h % 24) / 2)}`);
    }
  }
  return out;
}

/** grid[row][slot], rows Mon … Sun. */
export function heatGrid(points: SeriesPoint[], w: PatchWindow): HeatCell[][] {
  const sum = new Map<string, { total: number; n: number }>();
  for (const p of points) {
    if (p.requestsPerMin == null) continue;
    const d = new Date(p.t);
    const k = `${d.getUTCDay()}:${Math.floor(d.getUTCHours() / 2)}`;
    const cur = sum.get(k) ?? { total: 0, n: 0 };
    sum.set(k, { total: cur.total + p.requestsPerMin, n: cur.n + 1 });
  }
  const rates = [...sum.values()].map((v) => v.total / v.n);
  const max = Math.max(0, ...rates);
  const win = windowSlots(w);
  return ROW_DAYS.map((day) =>
    Array.from({ length: SLOTS }, (_, slot) => {
      const v = sum.get(`${day}:${slot}`);
      const rate = v ? v.total / v.n : null;
      return { rate, level: rate == null ? null : max > 0 ? rate / max : 0, inWindow: win.has(`${day}:${slot}`) };
    }),
  );
}

/** "Sun 04:00–06:00 UTC" — the quietest slot that has data; null without data. */
export function quietestSlot(grid: HeatCell[][]): string | null {
  let best: { row: number; slot: number; rate: number } | null = null;
  grid.forEach((cells, row) =>
    cells.forEach((c, slot) => {
      if (c.rate != null && (!best || c.rate < best.rate)) best = { row, slot, rate: c.rate };
    }),
  );
  if (!best) return null;
  const { row, slot } = best as { row: number; slot: number };
  const hh = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;
  return `${DAY_NAMES[ROW_DAYS[row]!]} ${hh(slot * 2)}–${hh(slot * 2 + 2)} UTC`;
}
