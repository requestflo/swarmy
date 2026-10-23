import type { ReleaseView } from '@swarmy/core';
import { backtest, type BacktestGrid } from '@/components/alerts/rule-backtest';
import { releaseLabel } from '../releases/release-label';

/**
 * "Would have caught v1.8.3" (board AppRollout): the week's error rate for
 * one part replayed against a canary's error ceiling. A crossing counts as
 * caught when it starts inside a release's watch window — that's the only
 * time a canary is looking; later crossings are said as misses, honestly.
 * PURE — unit-tested in catch-model.test.ts.
 */

export interface Shipped {
  at: number;
  /** "v1.8.3" — the part's own image tag in that release. */
  label: string;
}

export interface Crossing {
  start: number;
  peak: number;
  /** The release it followed, if one went out this week or before. */
  after: Shipped | null;
  caught: boolean;
}

export interface CatchResult {
  crossings: Crossing[];
  peak: { v: number; at: number } | null;
}

/** The part's version in each release (its own image, else the release's first), oldest first. */
export function shippedVersions(releases: ReleaseView[], part: string): Shipped[] {
  return releases
    .map((r) => {
      const own = r.images.find((i) => i.name === part);
      return { at: Date.parse(r.createdAt), label: releaseLabel(own ? { ...r, images: [own] } : r) };
    })
    .filter((s) => Number.isFinite(s.at))
    .sort((a, b) => a.at - b.at);
}

export function catchReleases(values: Array<number | null>, grid: BacktestGrid, shipped: Shipped[], tripPct: number, windowMin: number): CatchResult {
  const { fires } = backtest([{ name: 'part', values }], grid, tripPct, 0);
  // A release goes out mid-slot; the slot that holds it is inside its window too.
  const reach = windowMin * 60_000 + grid.stepMs;
  const crossings = fires.map((f): Crossing => {
    const after = [...shipped].reverse().find((s) => s.at <= f.start + grid.stepMs) ?? null;
    return { start: f.start, peak: f.peak, after, caught: after !== null && f.start - after.at <= reach };
  });
  let peak: CatchResult['peak'] = null;
  values.forEach((v, i) => {
    if (v !== null && (!peak || v > peak.v)) peak = { v, at: grid.from + i * grid.stepMs };
  });
  return { crossings, peak };
}

export const pctWords = (v: number): string => `${v < 10 ? Math.round(v * 10) / 10 : Math.round(v)}%`;

/** The receipt under the chart. `when` formats a time ("Thu 10:20"). */
export function receiptWords(r: CatchResult, tripPct: number, windowMin: number, when: (t: number) => string): string {
  const caught = r.crossings.filter((c) => c.caught && c.after);
  const missed = r.crossings.filter((c) => !c.caught);
  const parts: string[] = [];
  if (caught.length) {
    const list = caught.map((c) => `${c.after!.label} (${when(c.start)}, ${pctWords(c.peak)} errors)`);
    parts.push(`At ${tripPct}% it would have put back ${list.join(' and ')}.`);
  }
  if (missed.length) {
    const m = missed[0]!;
    const since = m.after ? `, ${gapWords(m.start - m.after.at)} after ${m.after.label} went out` : '';
    const more = missed.length > 1 ? ` and ${missed.length - 1} more time${missed.length === 2 ? '' : 's'}` : '';
    parts.push(`Errors passed ${tripPct}% on ${when(m.start)} (${pctWords(m.peak)})${since}${more}, when no canary was watching: it only watches the first ${windowMin} min.`);
  }
  if (!parts.length) {
    parts.push(r.peak ? `Errors never passed ${tripPct}% this week (the worst was ${pctWords(r.peak.v)}, ${when(r.peak.at)}), so there was nothing to put back.` : `Errors never passed ${tripPct}% this week.`);
  }
  return parts.join(' ');
}

/** "40 min" · "3 hours" · "2 days". */
export function gapWords(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 90) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 36) return `${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'}`;
}
