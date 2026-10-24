import { apportion } from './apportion';
import { addLatency, apportionLatency, latencyView, type LatencyBuckets, type LatencyView } from './edge-latency';
import type { EdgeHostTraffic } from './protocol/stats';

/**
 * What a ring cell / rollup row carries beside requests and 5xx: the 403 and
 * 429 answers ("blocked" = their sum) and the request-duration buckets.
 * Every field is optional — undefined means the edge did not report it (an
 * older agent), which reads as "no number", never as zero.
 */
export interface HostExtras {
  status403?: number;
  status429?: number;
  latency?: LatencyBuckets;
}

/** Split one host's extras over the minutes a delta overlaps (parts add up exactly). */
export function apportionExtras(h: EdgeHostTraffic, weights: readonly number[]): HostExtras[] {
  const s403 = h.status403 === undefined ? undefined : apportion(h.status403, weights);
  const s429 = h.status429 === undefined ? undefined : apportion(h.status429, weights);
  const lat = h.latency ? apportionLatency(h.latency, weights) : undefined;
  return weights.map((_, i) => {
    const e: HostExtras = {};
    if (s403) e.status403 = s403[i]!;
    if (s429) e.status429 = s429[i]!;
    if (lat?.[i]) e.latency = lat[i];
    return e;
  });
}

/** Add `e` into `into` (in place). A reported zero stays a reported zero. */
export function addExtras(into: HostExtras, e: HostExtras): void {
  if (e.status403 !== undefined) into.status403 = (into.status403 ?? 0) + e.status403;
  if (e.status429 !== undefined) into.status429 = (into.status429 ?? 0) + e.status429;
  if (e.latency) into.latency = addLatency(into.latency, e.latency);
}

/** 403 + 429, or undefined when neither was reported. */
export function blockedOf(e: HostExtras): number | undefined {
  return e.status403 === undefined && e.status429 === undefined ? undefined : (e.status403 ?? 0) + (e.status429 ?? 0);
}

/** Every reporting edge's merged histogram over `[start, end)` (edges with no covered minute left out). */
export function edgeLatencies(args: {
  cells: ReadonlyArray<{ t: number; nodeId: string } & HostExtras>;
  covered: ReadonlyMap<string, number>;
  start: number;
  end: number;
}): Map<string, LatencyBuckets> {
  const out = new Map<string, LatencyBuckets>();
  for (const c of args.cells) {
    if (c.t < args.start || c.t >= args.end || !c.latency || !args.covered.get(c.nodeId)) continue;
    const merged = addLatency(out.get(c.nodeId), c.latency);
    if (merged) out.set(c.nodeId, merged);
  }
  return out;
}

/** Merge several histograms (a region's edges, every edge) into one view. */
export function mergedView(hs: Iterable<LatencyBuckets | undefined>): LatencyView {
  let acc: LatencyBuckets | undefined;
  for (const h of hs) acc = addLatency(acc, h);
  return latencyView(acc);
}

/** Per series point: p50/p95 over the bucket's merged histogram and blocked a minute. */
export interface SeriesExtrasPoint extends LatencyView {
  /** 403 + 429 a minute; null = no report of status codes in this bucket. */
  blockedPerMin: number | null;
}

/**
 * Fold rows' extras into `n` buckets of `bucketMs` from `start`. A bucket
 * with no reported status codes reads null blocked; with no observations,
 * null percentiles.
 */
export function bucketSeriesExtras(args: {
  rows: ReadonlyArray<{ t: number } & HostExtras>;
  start: number;
  bucketMs: number;
  n: number;
  covered: readonly boolean[];
}): SeriesExtrasPoint[] {
  const acc = Array.from({ length: args.n }, () => ({}) as HostExtras);
  for (const r of args.rows) {
    const i = Math.floor((r.t - args.start) / args.bucketMs);
    if (i >= 0 && i < args.n) addExtras(acc[i]!, r);
  }
  const perMin = args.bucketMs / 60_000;
  return acc.map((e, i) => {
    const blocked = blockedOf(e);
    return {
      ...latencyView(e.latency),
      blockedPerMin: args.covered[i] && blocked !== undefined ? Math.round((blocked / perMin) * 10) / 10 : null,
    };
  });
}
