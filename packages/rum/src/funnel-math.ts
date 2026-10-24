/**
 * Funnel arithmetic over the `buildFunnelQuery` histogram — pure.
 *
 * "Biggest drop" is the step-to-step transition that loses the largest share
 * of the visitors who reached the step before it (ties: the most people lost).
 * "Since vN" is said only when the data supports it: pooling the releases on
 * either side of a deploy, conversion at that transition fell by at least
 * {@link SINCE_MIN_FALL} with at least {@link SINCE_MIN_SIDE} entrants on each
 * side, and a two-proportion z-test clears {@link SINCE_MIN_Z}. Otherwise the
 * sentence names the drop and nothing more.
 */
import type { FunnelReleaseBoundary, FunnelRow } from './funnel-query';

/** A transition needs this many entrants before it can be the biggest drop. */
export const DROP_MIN_ENTRANTS = 10;
export const SINCE_MIN_SIDE = 20;
export const SINCE_MIN_FALL = 0.05;
export const SINCE_MIN_Z = 1.96;

export interface FunnelStepCount {
  visitors: number;
  /** Share of the previous step's visitors who got here (1 for the first step). */
  conversion: number;
  /** 1 − conversion. */
  dropOff: number;
}

export interface FunnelDrop {
  /** Index of the step the visitors failed to reach (≥ 1). */
  index: number;
  dropOff: number;
  lost: number;
}

export interface FunnelSince {
  releaseId: string;
  /** Conversion at the drop before / since that release. */
  before: number;
  after: number;
}

export interface FunnelReleaseSplit {
  /** '' = visits that began before the oldest release swarmy knows of. */
  releaseId: string;
  entered: number;
  /** Visitors at the biggest drop's two steps under this release. */
  reached: number;
  converted: number;
}

const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0) || 0);

/** Level histogram → visitors at each step (units with level ≥ k). */
export function stepVisitors(rows: readonly FunnelRow[], steps: number): number[] {
  const out = new Array<number>(steps).fill(0);
  for (const r of rows) {
    const level = Math.min(steps, Math.floor(n(r.level)));
    for (let k = 0; k < level; k++) out[k]! += n(r.units);
  }
  return out;
}

export function stepCounts(visitors: readonly number[]): FunnelStepCount[] {
  return visitors.map((v, i) => {
    const prev = i === 0 ? v : visitors[i - 1]!;
    const conversion = i === 0 ? 1 : prev > 0 ? v / prev : 0;
    return { visitors: v, conversion, dropOff: 1 - conversion };
  });
}

export function biggestDrop(visitors: readonly number[]): FunnelDrop | null {
  let best: FunnelDrop | null = null;
  for (let i = 1; i < visitors.length; i++) {
    const prev = visitors[i - 1]!;
    if (prev < DROP_MIN_ENTRANTS) continue;
    const lost = prev - visitors[i]!;
    const dropOff = lost / prev;
    if (lost <= 0) continue;
    if (!best || dropOff > best.dropOff || (dropOff === best.dropOff && lost > best.lost)) best = { index: i, dropOff, lost };
  }
  return best;
}

/** Visitors at the drop's two steps, per release (newest release first). */
export function releaseSplits(rows: readonly FunnelRow[], steps: number, drop: FunnelDrop): FunnelReleaseSplit[] {
  const by = new Map<string, FunnelRow[]>();
  for (const r of rows) by.set(r.release, [...(by.get(r.release) ?? []), r]);
  return [...by].map(([releaseId, rs]) => {
    const v = stepVisitors(rs, steps);
    return { releaseId, entered: v[0]!, reached: v[drop.index - 1]!, converted: v[drop.index]! };
  });
}

function zFall(b: { reached: number; converted: number }, a: { reached: number; converted: number }): number {
  const p1 = b.converted / b.reached;
  const p2 = a.converted / a.reached;
  const p = (b.converted + a.converted) / (b.reached + a.reached);
  const se = Math.sqrt(p * (1 - p) * (1 / b.reached + 1 / a.reached));
  return se > 0 ? (p1 - p2) / se : 0;
}

/**
 * The deploy since which the drop got worse, if the numbers support it.
 * `releases` are the boundaries the query used. Each deploy splits the
 * window into "before" and "since"; of the splits where "since" is clearly
 * worse, the one with the strongest evidence (largest z) wins.
 */
export function dropSince(splits: readonly FunnelReleaseSplit[], releases: readonly FunnelReleaseBoundary[]): FunnelSince | null {
  const order = [...releases].sort((x, y) => x.fromMs - y.fromMs).map((r) => r.id);
  const rank = (id: string): number => (id === '' ? -1 : order.indexOf(id));
  const seq = [...splits].filter((s) => s.releaseId === '' || order.includes(s.releaseId)).sort((x, y) => rank(x.releaseId) - rank(y.releaseId));
  const pool = (xs: readonly FunnelReleaseSplit[]) =>
    xs.reduce((acc, s) => ({ reached: acc.reached + s.reached, converted: acc.converted + s.converted }), { reached: 0, converted: 0 });
  let best: (FunnelSince & { z: number }) | null = null;
  for (let b = 1; b < seq.length; b++) {
    const before = pool(seq.slice(0, b));
    const after = pool(seq.slice(b));
    if (before.reached < SINCE_MIN_SIDE || after.reached < SINCE_MIN_SIDE) continue;
    const cb = before.converted / before.reached;
    const ca = after.converted / after.reached;
    const z = zFall(before, after);
    if (cb - ca < SINCE_MIN_FALL || z < SINCE_MIN_Z) continue;
    if (!best || z > best.z) best = { releaseId: seq[b]!.releaseId, before: cb, after: ca, z };
  }
  return best ? { releaseId: best.releaseId, before: best.before, after: best.after } : null;
}
