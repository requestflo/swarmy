import type { BucketSizeHistoryView } from '@swarmy/core';
import { slotStart } from '@/components/history/history-model';
import { fmtBytes } from './format';

/**
 * A bucket's growth (board 42 "+310 MB this week · full in ~20 months"),
 * from `buckets.sizeHistory` (7 days of hourly slots). Honest by rule:
 * nothing is claimed until there are 3 days of readings, and a fill date is
 * only forecast while the size is really going up (a least-squares trend
 * over the week, so one big upload or delete doesn't swing it) and there is
 * a limit to fill. PURE — unit-tested in bucket-growth-model.test.ts.
 */

export const MIN_HISTORY_DAYS = 3;
const DAY = 86_400_000;

export type BucketGrowth =
  | { kind: 'not-enough'; spanDays: number }
  | {
      kind: 'trend';
      spanDays: number;
      /** Newest reading − oldest reading in the window. */
      weekBytes: number;
      /** The trend's slope. */
      perDayBytes: number;
      /** Days until the limit at the trend; null = no limit, or not growing. 0 = already there. */
      fullInDays: number | null;
    };

export function bucketGrowth(h: BucketSizeHistoryView, limitBytes: number | null, usageBytes?: number): BucketGrowth {
  const pts = h.bytes.flatMap((v, i) => (v === null ? [] : [{ t: slotStart(h, i), v }]));
  const spanDays = pts.length > 1 ? (pts[pts.length - 1]!.t - pts[0]!.t) / DAY : 0;
  if (spanDays < MIN_HISTORY_DAYS) return { kind: 'not-enough', spanDays };
  const mt = pts.reduce((s, p) => s + p.t, 0) / pts.length;
  const mv = pts.reduce((s, p) => s + p.v, 0) / pts.length;
  const cov = pts.reduce((s, p) => s + (p.t - mt) * (p.v - mv), 0);
  const varT = pts.reduce((s, p) => s + (p.t - mt) ** 2, 0);
  const perDayBytes = varT > 0 ? (cov / varT) * DAY : 0;
  const weekBytes = pts[pts.length - 1]!.v - pts[0]!.v;
  const now = usageBytes ?? pts[pts.length - 1]!.v;
  const growing = perDayBytes > 0 && weekBytes > 0;
  const fullInDays = limitBytes && limitBytes > 0 && growing ? Math.max(0, (limitBytes - now) / perDayBytes) : null;
  return { kind: 'trend', spanDays, weekBytes, perDayBytes, fullInDays };
}

/** "~20 months", "~3 weeks", "~5 days". */
export function fillWords(days: number): string {
  if (days < 1) return 'within a day';
  if (days < 14) return `~${Math.round(days)} days`;
  if (days < 63) return `~${Math.round(days / 7)} weeks`;
  if (days < 1095) return `~${Math.round(days / 30.44)} months`;
  return `~${Math.round(days / 365)} years`;
}

/** The size row's two clauses: the week's change, and the fill forecast (or why there is none). */
export function growthWords(g: BucketGrowth, hasLimit: boolean): { change: string; forecast: string | null } {
  if (g.kind === 'not-enough') return { change: 'not enough history yet', forecast: null };
  const delta = Math.abs(g.weekBytes);
  const change = g.weekBytes > 0 ? `+${fmtBytes(delta)} this week` : g.weekBytes < 0 ? `−${fmtBytes(delta)} this week` : 'no change this week';
  if (g.fullInDays === 0) return { change, forecast: 'at the limit now' };
  if (g.fullInDays !== null) return { change, forecast: `full in ${fillWords(g.fullInDays)}` };
  return { change, forecast: hasLimit ? 'not filling up' : null };
}
