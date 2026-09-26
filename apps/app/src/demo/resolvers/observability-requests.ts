import type { DemoHandler, DemoStore } from '../types';

/**
 * `observability.requestSeries` demo: calls, errors and p95 per bucket for a
 * stack's entry spans. storefront is calm (≈0.3% errors, p95 ≈ 420 ms) until
 * its newest release goes out; from then checkout's Stripe timeouts show:
 * errors near 6% and p95 near 10 s — the incident room's chart and marker.
 * Shapes mirror `RequestSeriesRow` in observability-query.ts.
 */

interface Row {
  bucket: string;
  calls: number;
  errors: number;
  p95_ms: number;
}

const CALLS_PER_MIN: Record<string, number> = { storefront: 510, data: 42, platform: 38 };

/** Deterministic noise in [-1, 1] per key (FNV-1a). */
function noise(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

function newestRelease(s: DemoStore, stack: string): number | null {
  const rows = (s.extra.releases as { releases?: Array<{ stackName: string; createdAt: string }> } | undefined)?.releases ?? [];
  const r = rows.find((x) => x.stackName === stack);
  return r ? Date.parse(r.createdAt) : null;
}

const stamp = (t: number): string => new Date(t).toISOString().replace('T', ' ').slice(0, 19);

const requestSeries: DemoHandler = (i, s) => {
  const q = (i as { stack?: string; windowMinutes?: number; bucketSeconds?: number } | undefined) ?? {};
  const enabled = (s.extra.observability as { config?: { enabled?: boolean } } | undefined)?.config?.enabled ?? true;
  if (!enabled) return { status: 'disabled', points: [] };
  const stack = q.stack ?? 'storefront';
  const perMin = CALLS_PER_MIN[stack];
  if (!perMin) return { status: 'ok', points: [] };
  const bucketMs = (q.bucketSeconds ?? 300) * 1000;
  const windowMs = (q.windowMinutes ?? 180) * 60_000;
  const end = Math.floor(Date.now() / bucketMs) * bucketMs;
  const releasedAt = stack === 'storefront' ? newestRelease(s, stack) : null;
  const points: Row[] = [];
  for (let t = end - windowMs + bucketMs; t <= end; t += bucketMs) {
    const n = noise(`${stack}|${t / bucketMs}`);
    const calls = Math.round(perMin * (bucketMs / 60_000) * (1 + 0.08 * n));
    // A bucket that ends after the release carries its errors.
    const bad = releasedAt !== null && t + bucketMs > releasedAt + 60_000;
    const share = bad ? 0.058 + 0.006 * n : 0.003 + 0.0015 * n;
    points.push({ bucket: stamp(t), calls, errors: Math.round(calls * share), p95_ms: bad ? Math.round(9_600 + 400 * n) : Math.round(420 + 40 * n) });
  }
  return { status: 'ok', points };
};

export const requestHandlers: Record<string, DemoHandler> = {
  'observability.requestSeries': requestSeries,
};
