/**
 * `observability.requestSeries` for ONE service (the `service` filter, which
 * Config › Scaling's "Yesterday, if it had slept" replays). Each Northwind
 * part keeps believable hours: web and api never go quiet; checkout sells by
 * day and sees a stray order or two at night; cdn-edge (sleep already on)
 * only fills caches at the morning, lunch and evening rushes. Empty buckets
 * return no row, as ClickHouse's GROUP BY does.
 */

interface Row {
  bucket: string;
  calls: number;
  errors: number;
  p95_ms: number;
}

/** 0 at 06:00, 1 at 15:00, 0 at midnight. */
const day = (h: number): number => (h < 6 ? 0 : Math.max(0, Math.sin((Math.PI * (h - 6)) / 18)));
const within = (h: number, spans: Array<[number, number]>): boolean => spans.some(([a, b]) => h >= a && h < b);

/** Requests a minute at local hour `h`; `n` is per-bucket noise in [-1, 1]. */
const PROFILES: Record<string, (h: number, n: number) => number> = {
  web: (h) => 60 + 520 * day(h),
  api: (h) => 90 + 780 * day(h),
  checkout: (h, n) => (within(h, [[7.5, 23.5]]) ? 6 + 20 * day(h) : n > 0.86 ? 0.4 : 0),
  'cdn-edge': (h, n) => (within(h, [[7, 10], [12, 14], [17, 22]]) ? 8 + 26 * day(h) : n > 0.92 ? 0.2 : 0),
  default: (h) => (within(h, [[6, 23]]) ? 10 * (0.5 + day(h)) : 0),
};

/** Deterministic noise in [-1, 1] per key (FNV-1a). */
function noise(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

const stamp = (t: number): string => new Date(t).toISOString().replace('T', ' ').slice(0, 19);

export function serviceRequestSeries(q: { stack?: string; service: string; windowMinutes?: number; bucketSeconds?: number }): Row[] {
  // OTEL_SERVICE_NAME is `storefront-web` in the demo; a part without one sends its own name.
  const key = q.stack ? q.service.replace(`${q.stack}-`, '').replace(`${q.stack}_`, '') : q.service;
  const profile = PROFILES[key] ?? PROFILES.default!;
  const bucketMs = (q.bucketSeconds ?? 300) * 1000;
  const windowMs = (q.windowMinutes ?? 180) * 60_000;
  const end = Math.floor(Date.now() / bucketMs) * bucketMs;
  const points: Row[] = [];
  for (let t = end - windowMs + bucketMs; t <= end; t += bucketMs) {
    const d = new Date(t);
    const n = noise(`${q.service}|${t / bucketMs}`);
    const calls = Math.round(profile(d.getHours() + d.getMinutes() / 60, n) * (bucketMs / 60_000) * (1 + 0.1 * n));
    if (calls <= 0) continue;
    points.push({ bucket: stamp(t), calls, errors: Math.round(calls * 0.003), p95_ms: Math.round(380 + 60 * n) });
  }
  return points;
}
