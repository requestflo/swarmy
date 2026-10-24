import type { DemoHandler, DemoStore } from '../types';
import { serviceRequestSeries } from './observability-requests-service';

/**
 * `observability.requestSeries` demo: calls, errors and p95 per bucket for a
 * stack's entry spans. storefront is calm (≈0.3% errors, p95 ≈ 420 ms) until
 * its newest release goes out; from then checkout's Stripe timeouts show:
 * errors near 6% and p95 near 10 s — the incident room's chart and marker.
 * Asked for one part (`service`), it is that part's share of the calls, with
 * the week's error bursts the alert feed recorded (alerts.ts) — what the alert
 * rule editor replays for "would have fired".
 * Shapes mirror `RequestSeriesRow` in observability-query.ts (and the
 * batched `observability-request-many.ts`).
 */

interface Row {
  bucket: string;
  calls: number;
  errors: number;
  p95_ms: number;
}

const CALLS_PER_MIN: Record<string, number> = { storefront: 510, data: 42, platform: 38 };
/** A part's share of its app's calls (others: a quarter). */
const PART_SHARE: Record<string, number> = { storefront_web: 0.4, storefront_api: 0.22, storefront_checkout: 0.26, 'storefront_cdn-edge': 0.12 };
const M = 60_000;
const H = 60 * M;
const D = 24 * H;
/** The week's error bursts, as the alert feed has them: part, started (ms ago), minutes long, error share. */
const BURSTS: Array<[string, number, number, number]> = [
  ['storefront_checkout', 2 * D + 5 * H, 26, 0.079],
  ['storefront_checkout', 4 * D + 2 * H, 9, 0.034],
  ['storefront_api', 5 * D + 9 * H, 12, 0.054],
];

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
  const q = (i as { stack?: string; service?: string; windowMinutes?: number; bucketSeconds?: number } | undefined) ?? {};
  const enabled = (s.extra.observability as { config?: { enabled?: boolean } } | undefined)?.config?.enabled ?? true;
  if (!enabled) return { status: 'disabled', points: [] };
  if (q.service) {
    // Docker names (`storefront_checkout`, the alert backtest's parts) carry the
    // week's bursts; span names (`storefront-web`, the demo's OTEL_SERVICE_NAME,
    // what Scaling's sleep replay asks for) follow each part's day.
    if (q.service.includes('_')) return partSeries(q.service, q, s);
    return { status: 'ok', points: serviceRequestSeries({ ...q, service: q.service }) };
  }
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

/** One part: its share of the app's calls; checkout fails since the release, plus the week's bursts. */
function partSeries(service: string, q: { stack?: string; windowMinutes?: number; bucketSeconds?: number }, s: DemoStore): { status: string; points: Row[] } {
  const stack = q.stack ?? service.split('_')[0] ?? '';
  const perMin = (CALLS_PER_MIN[stack] ?? 0) * (PART_SHARE[service] ?? 0.25);
  if (!perMin) return { status: 'ok', points: [] };
  const bucketMs = (q.bucketSeconds ?? 300) * 1000;
  const windowMs = (q.windowMinutes ?? 180) * M;
  const now = Date.now();
  const end = Math.floor(now / bucketMs) * bucketMs;
  const releasedAt = service === 'storefront_checkout' ? newestRelease(s, stack) : null;
  const points: Row[] = [];
  for (let t = end - windowMs + bucketMs; t <= end; t += bucketMs) {
    const n = noise(`${service}|${t / bucketMs}`);
    const calls = Math.round(perMin * (bucketMs / M) * (1 + 0.08 * n));
    // The share of this bucket each burst (or the release) covers, blended with the calm rate.
    let share = 0.003 + 0.0015 * n;
    let slow = false;
    const spans: Array<[number, number, number]> = BURSTS.filter((b) => b[0] === service).map((b) => [now - b[1], now - b[1] + b[2] * M, b[3]]);
    if (releasedAt !== null) spans.push([releasedAt + 60_000, Infinity, 0.062]);
    for (const [from, to, bad] of spans) {
      const f = Math.max(0, Math.min(t + bucketMs, to) - Math.max(t, from)) / bucketMs;
      if (f > 0) share = share * (1 - f) + (bad + 0.004 * n) * f;
      slow ||= f > 0.5;
    }
    points.push({ bucket: stamp(t), calls, errors: Math.round(calls * share), p95_ms: slow ? Math.round(9_600 + 400 * n) : Math.round(420 + 40 * n) });
  }
  return { status: 'ok', points };
}

/**
 * `observability.requestSeriesMany` (the canvas's per-part sparklines): spans
 * carry each part's OTEL_SERVICE_NAME (`storefront-web`), so only those names
 * answer, each with its part's day; other names have no spans, as in ClickHouse.
 */
const requestSeriesMany: DemoHandler = (i, s) => {
  const q = i as { stack: string; services: string[]; windowMinutes?: number; bucketSeconds?: number };
  const enabled = (s.extra.observability as { config?: { enabled?: boolean } } | undefined)?.config?.enabled ?? true;
  if (!enabled) return { status: 'disabled', series: [] };
  const series = [...new Set(q.services)]
    .filter((name) => name.startsWith(`${q.stack}-`))
    .map((service) => ({ service, points: serviceRequestSeries({ stack: q.stack, service, windowMinutes: q.windowMinutes ?? 60, bucketSeconds: q.bucketSeconds ?? 120 }) }))
    .filter((x) => x.points.length > 0);
  return { status: 'ok', series };
};

export const requestHandlers: Record<string, DemoHandler> = {
  'observability.requestSeries': requestSeries,
  'observability.requestSeriesMany': requestSeriesMany,
};
