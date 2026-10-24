import { apportion } from './apportion';
import type { EdgeLatencyBuckets } from './protocol/stats';

/**
 * Request-duration histograms for the edge (latency per edge and per host) —
 * pure maths, shared by the agent, the controller ring and the rollups.
 *
 * A histogram is Caddy's `caddy_http_request_duration_seconds` as PER-BUCKET
 * counts: `bounds` are the finite upper bounds in seconds (ascending) and
 * `counts` has one more entry, the +Inf overflow bucket. Histograms merge by
 * adding bucket counts, so percentiles across edges come from the merged
 * counts, never from averaging each edge's percentile.
 */
export type LatencyBuckets = EdgeLatencyBuckets;

/** Total observations in a histogram. */
export function latencyCount(h: LatencyBuckets | undefined): number {
  return h ? h.counts.reduce((a, b) => a + b, 0) : 0;
}

const sameBounds = (a: readonly number[], b: readonly number[]): boolean =>
  a === b || (a.length === b.length && a.every((x, i) => x === b[i]));

/**
 * Add two histograms. Identical bounds (every Caddy shares the same default
 * buckets) add bucket by bucket and keep `a`'s bounds array. Different bounds
 * merge onto the union: each count stays at its own upper bound, so the
 * cumulative count at any shared bound is exact.
 */
export function mergeLatency(a: LatencyBuckets | undefined, b: LatencyBuckets | undefined): LatencyBuckets | undefined {
  if (!a) return b && { bounds: b.bounds, counts: [...b.counts] };
  if (!b) return { bounds: a.bounds, counts: [...a.counts] };
  if (sameBounds(a.bounds, b.bounds)) return { bounds: a.bounds, counts: a.counts.map((c, i) => c + (b.counts[i] ?? 0)) };
  const bounds = [...new Set([...a.bounds, ...b.bounds])].sort((x, y) => x - y);
  const counts = new Array<number>(bounds.length + 1).fill(0);
  for (const h of [a, b]) {
    h.counts.forEach((c, i) => {
      const at = i < h.bounds.length ? bounds.indexOf(h.bounds[i]!) : bounds.length;
      counts[at]! += c;
    });
  }
  return { bounds, counts };
}

/**
 * Add `b` into the accumulator `a` — in place when the bounds match, so `a`
 * must be the caller's own (one that {@link mergeLatency} or this returned).
 */
export function addLatency(a: LatencyBuckets | undefined, b: LatencyBuckets | undefined): LatencyBuckets | undefined {
  if (!b) return a;
  if (a && sameBounds(a.bounds, b.bounds)) {
    b.counts.forEach((c, i) => (a.counts[i]! += c));
    return a;
  }
  return mergeLatency(a, b);
}

/**
 * Split a histogram over weights (the minutes a delta overlaps): each bucket
 * is apportioned on its own, so the parts add back to exactly the whole.
 * Parts with no observations are undefined.
 */
export function apportionLatency(h: LatencyBuckets, weights: readonly number[]): Array<LatencyBuckets | undefined> {
  const per = h.counts.map((c) => apportion(c, weights));
  return weights.map((_, i) => {
    const counts = per.map((p) => p[i]!);
    return counts.some((c) => c > 0) ? { bounds: h.bounds, counts } : undefined;
  });
}

/**
 * The q-quantile (0..1) in seconds, as Prometheus' `histogram_quantile`
 * estimates it: linear inside the bucket the rank falls in, the first bucket
 * starting at 0. A rank in the +Inf bucket reads as the highest finite bound.
 * Null with no observations.
 */
export function latencyQuantile(h: LatencyBuckets | undefined, q: number): number | null {
  const total = latencyCount(h);
  if (!h || total === 0) return null;
  const rank = Math.min(1, Math.max(0, q)) * total;
  let below = 0;
  for (let i = 0; i < h.counts.length; i++) {
    const c = h.counts[i]!;
    if (below + c >= rank && c > 0) {
      if (i >= h.bounds.length) return h.bounds.at(-1) ?? null;
      const lower = i === 0 ? 0 : h.bounds[i - 1]!;
      const upper = h.bounds[i]!;
      return lower + ((upper - lower) * (rank - below)) / c;
    }
    below += c;
  }
  return h.bounds.at(-1) ?? null;
}

/** p50 / p95 in milliseconds (one decimal), null when nothing was observed. */
export interface LatencyView {
  p50Ms: number | null;
  p95Ms: number | null;
}

const ms = (s: number | null): number | null => (s === null ? null : Math.round(s * 10_000) / 10);

export function latencyView(h: LatencyBuckets | undefined): LatencyView {
  return { p50Ms: ms(latencyQuantile(h, 0.5)), p95Ms: ms(latencyQuantile(h, 0.95)) };
}

/** Compact text for a telemetry.db column: `{"b":[bounds],"c":[counts]}`. */
export function encodeLatency(h: LatencyBuckets): string {
  return JSON.stringify({ b: h.bounds, c: h.counts });
}

/** Read {@link encodeLatency} back; undefined for null, junk or a malformed shape. */
export function decodeLatency(text: string | null | undefined): LatencyBuckets | undefined {
  if (!text) return undefined;
  try {
    const v = JSON.parse(text) as { b?: unknown; c?: unknown };
    const ok = (xs: unknown): xs is number[] => Array.isArray(xs) && xs.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0);
    if (!ok(v.b) || !ok(v.c) || v.c.length !== v.b.length + 1) return undefined;
    return { bounds: v.b, counts: v.c };
  } catch {
    return undefined;
  }
}
