import type { BucketSizeHistoryView } from '@swarmy/core';
import { slotStart } from '@/components/history/history-model';
import { fmtBytes } from './format';
import { linearFit, nextMilestone } from './linear-fit';

/**
 * A bucket's growth and forecast (board 42: "+310 MB this week · At this rate
 * it reaches its 50 GB limit around 14 Mar"), from `buckets.sizeHistory`
 * (BucketStatSample: 7 days in hourly slots, each the slot's largest
 * reading). A least-squares line over the readings; a date is given only
 * when that line means something:
 *   - 3+ days and 24+ readings, else "not enough history";
 *   - the line moves the size by more than 0.5% (and 1 MB) a week, else "flat";
 *   - it explains most of the movement (R² ≥ 0.6), else "uneven": a few big
 *     uploads or deletes would swing any date;
 *   - the date is within three years, else "more than three years".
 * The size it reaches is the bucket's limit when it has one, else the next
 * round size a quarter or more above today's. PURE — bucket-growth-model.test.ts.
 */

export const MIN_HISTORY_DAYS = 3;
export const MIN_READINGS = 24;
export const MIN_R2 = 0.6;
/** Under this share of the size per week (or 1 MB), growth is flat. */
export const FLAT_WEEK_SHARE = 0.005;
export const HORIZON_DAYS = 3 * 365;
const DAY = 86_400_000;
const MB = 1024 * 1024;

export type GrowthState = 'not-enough' | 'flat' | 'shrinking' | 'uneven' | 'growing';

export interface GrowthForecast {
  /** The size it reaches: the limit, or the next round size. */
  bytes: number;
  isLimit: boolean;
  /** Already there (only a limit can be). */
  reached: boolean;
  /** When, at the trend (ms); null = beyond the horizon. */
  at: number | null;
}

export interface BucketGrowth {
  state: GrowthState;
  spanDays: number;
  readings: number;
  /** Newest reading − oldest (0 when there isn't enough history). */
  weekBytes: number;
  /** The line's slope per day. */
  perDayBytes: number;
  r2: number | null;
  /** Only while growing. */
  forecast: GrowthForecast | null;
}

export function bucketGrowth(h: BucketSizeHistoryView, limitBytes: number | null, usageBytes?: number, now = Date.now()): BucketGrowth {
  const pts = h.bytes.flatMap((v, i) => (v === null ? [] : [{ t: slotStart(h, i), v }]));
  const first = pts[0];
  const last = pts[pts.length - 1];
  const spanDays = first && last ? (last.t - first.t) / DAY : 0;
  const none: BucketGrowth = { state: 'not-enough', spanDays, readings: pts.length, weekBytes: 0, perDayBytes: 0, r2: null, forecast: null };
  if (!first || !last || spanDays < MIN_HISTORY_DAYS || pts.length < MIN_READINGS) return none;
  const fit = linearFit(pts.map((p) => ({ x: (p.t - first.t) / DAY, y: p.v })));
  if (!fit) return none;
  const size = usageBytes ?? last.v;
  const g: BucketGrowth = { ...none, weekBytes: last.v - first.v, perDayBytes: fit.slope, r2: fit.r2 };
  if (Math.abs(fit.slope) * 7 <= Math.max(MB, size * FLAT_WEEK_SHARE)) return { ...g, state: 'flat' };
  if (fit.slope < 0) return { ...g, state: 'shrinking' };
  if (fit.r2 < MIN_R2) return { ...g, state: 'uneven' };
  const limit = limitBytes && limitBytes > 0 ? limitBytes : null;
  const bytes = limit ?? nextMilestone(size);
  const days = Math.max(0, (bytes - size) / fit.slope);
  return {
    ...g,
    state: 'growing',
    forecast: { bytes, isLimit: limit !== null, reached: size >= bytes, at: days > HORIZON_DAYS ? null : now + days * DAY },
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "14 Mar", or "14 Mar 2028" outside this year (UTC). */
export function dayWords(at: number, now: number): string {
  const d = new Date(at);
  const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return d.getUTCFullYear() === new Date(now).getUTCFullYear() ? day : `${day} ${d.getUTCFullYear()}`;
}

/** "50 GB", "1.5 TB" (no trailing ".0"). */
export function sizeWords(bytes: number): string {
  return fmtBytes(bytes).replace('.0 ', ' ');
}

/** The size row's change ("+310 MB this week") and the forecast sentence. */
export function growthWords(g: BucketGrowth, now = Date.now()): { change: string | null; forecast: string } {
  const delta = fmtBytes(Math.abs(g.weekBytes));
  const change = g.state === 'not-enough' ? null : g.weekBytes > 0 ? `+${delta} this week` : g.weekBytes < 0 ? `−${delta} this week` : 'no change this week';
  switch (g.state) {
    case 'not-enough':
      return { change, forecast: `Not enough history to forecast yet: a forecast needs ${MIN_HISTORY_DAYS} days of readings.` };
    case 'flat':
      return { change, forecast: 'Growth is flat: it has stayed about the same size all week.' };
    case 'shrinking':
      return { change, forecast: 'It got smaller this week, so it isn’t filling up.' };
    case 'uneven':
      return { change, forecast: 'Growth is uneven this week (a few big uploads or deletes), so there’s no honest date to give.' };
    case 'growing': {
      const f = g.forecast!;
      const what = f.isLimit ? `its ${sizeWords(f.bytes)} limit` : sizeWords(f.bytes);
      if (f.reached) return { change, forecast: `It has reached ${what}: new writes are refused until the limit goes up.` };
      if (f.at === null) return { change, forecast: `At this rate it stays under ${what} for more than three years.` };
      return { change, forecast: `At this rate it reaches ${what} around ${dayWords(f.at, now)}.` };
    }
  }
}

/** A limit reached, or due within 30 days: worth the amber. */
export function growthUrgent(g: BucketGrowth, now = Date.now()): boolean {
  const f = g.forecast;
  return !!f && f.isLimit && (f.reached || (f.at !== null && f.at - now < 30 * DAY));
}
