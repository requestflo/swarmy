/**
 * "Would have fired" — a rule's threshold and for-duration replayed over a
 * week of real readings. Pure. Every subject (a part's error rate, a server's
 * disk use) shares one fixed grid of slots; a slot is null where nothing was
 * read, which never counts as over the line.
 *
 * It mirrors the alert-evaluator: a reading counts when it is strictly above
 * the threshold, the for-duration gate needs it to stay above for at least
 * `forSeconds`, and each subject fires on its own (an app rule fires per part,
 * an any-server rule per server). A run of over-the-line slots lasts
 * `slots × step`; a run too short for the duration is a blip it ignores.
 */

export interface BacktestGrid {
  /** Start of slot 0 (ms). */
  from: number;
  stepMs: number;
  slots: number;
}

export interface BacktestSubject {
  /** "storefront / checkout" · "london-2". */
  name: string;
  /** One reading per slot (% for both signals today); null = no reading. */
  values: Array<number | null>;
}

export interface WouldFire {
  subject: string;
  start: number;
  end: number;
  /** The run reaches the newest slot: it would be firing now. */
  open: boolean;
  peak: number;
}

export interface Backtest {
  fires: WouldFire[];
  /** Crossings shorter than the for-duration. */
  blips: number;
}

/** Mirrors alert-evaluator's ERROR_RATE_WINDOW_MIN / ERROR_RATE_MIN_CALLS: 5-minute windows, 20+ calls. */
export const ERROR_RATE_STEP_SECONDS = 300;
export const ERROR_RATE_MIN_CALLS = 20;

export function backtest(subjects: BacktestSubject[], grid: BacktestGrid, threshold: number | null, forSeconds: number): Backtest {
  const fires: WouldFire[] = [];
  let blips = 0;
  if (threshold === null) return { fires, blips };
  for (const s of subjects) {
    let start = -1;
    let peak = -Infinity;
    for (let i = 0; i <= grid.slots; i++) {
      const v = i < grid.slots ? s.values[i] : null;
      const over = v !== null && v !== undefined && v > threshold;
      if (over) {
        if (start < 0) start = i;
        peak = Math.max(peak, v);
        continue;
      }
      if (start < 0) continue;
      if ((i - start) * grid.stepMs >= Math.max(0, forSeconds) * 1000) {
        fires.push({ subject: s.name, start: grid.from + start * grid.stepMs, end: grid.from + i * grid.stepMs, open: i === grid.slots, peak });
      } else blips++;
      start = -1;
      peak = -Infinity;
    }
  }
  return { fires: fires.sort((a, b) => a.start - b.start), blips };
}

/** Per slot, the highest reading of any subject — the line the chart draws. */
export function envelope(subjects: BacktestSubject[], slots: number): Array<number | null> {
  return Array.from({ length: slots }, (_, i) =>
    subjects.reduce<number | null>((m, s) => {
      const v = s.values[i];
      return v === null || v === undefined ? m : m === null ? v : Math.max(m, v);
    }, null),
  );
}

/** The highest reading in each run of `every` slots — few enough points to draw a week. */
export function coarsen(values: Array<number | null>, every: number): Array<number | null> {
  const out: Array<number | null> = [];
  for (let i = 0; i < values.length; i += every) {
    const known = values.slice(i, i + every).filter((v): v is number => v !== null);
    out.push(known.length ? Math.max(...known) : null);
  }
  return out;
}

export interface RequestBucket {
  bucket: string;
  calls: number;
  errors: number;
}

/** ClickHouse's "2026-10-23 10:05:00" (UTC) → ms. */
const bucketTime = (bucket: string): number => Date.parse(`${bucket.replace(' ', 'T')}Z`);

/** A grid of `days` ending with the slot that holds `now`. */
export function gridEndingAt(now: number, stepSeconds: number, days = 7): BacktestGrid {
  const stepMs = stepSeconds * 1000;
  const slots = Math.round((days * 86_400) / stepSeconds);
  return { from: (Math.floor(now / stepMs) - slots + 1) * stepMs, stepMs, slots };
}

/** requestSeries buckets → error % per slot; a slot under 20 calls has no reading, as in the evaluator. */
export function errorRateValues(points: RequestBucket[], grid: BacktestGrid, minCalls = ERROR_RATE_MIN_CALLS): Array<number | null> {
  const values = new Array<number | null>(grid.slots).fill(null);
  for (const p of points) {
    const i = Math.round((bucketTime(p.bucket) - grid.from) / grid.stepMs);
    if (i < 0 || i >= grid.slots || !(p.calls >= minCalls)) continue;
    values[i] = (p.errors / p.calls) * 100;
  }
  return values;
}
