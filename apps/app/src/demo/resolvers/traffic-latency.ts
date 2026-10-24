import { addLatency, latencyView, type LatencyBuckets, type TrafficNowView } from '@swarmy/core';
import { round1 } from './traffic-shape';

/**
 * Demo latency and blocked answers, built the way the controller builds them:
 * each (edge, address) gets a duration histogram on Caddy's default buckets,
 * and p50/p95 per edge, region, address and the estate come from MERGING
 * those histograms (@swarmy/core latencyView), never from averaging
 * percentiles. Blocked = each address's 403 + 429 share of its visits.
 */

const BOUNDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
/** A region's typical answer time (ms): eu-west is closest to the servers. */
const REGION_MEDIAN_MS: Record<string, number> = { 'eu-west': 34, 'us-east': 61, 'ap-south': 118 };
/** How much slower (or faster) an address answers than its edge's typical request. */
const HOST_FACTOR: Record<string, number> = { 'api.northwind.dev': 0.6, 'metrics.northwind.dev': 2.4, '203.0.113.10': 0.15, 'scanner.invalid': 0.1 };
/**
 * Share of visits answered 403 / 429. shop has a live rate limit (100 a
 * minute per visitor) — its bot rule drops connections, which are never
 * counted; metrics is IP-allow-listed and password-gated (abort + 401: not
 * "blocked" either). Scanner noise mostly hits 403s.
 */
const BLOCKED_SHARE: Record<string, [number, number]> = {
  'shop.northwind.dev': [0.006, 0.021],
  'api.northwind.dev': [0.003, 0],
  'web-store.203-0-113-10.sslip.io': [0.002, 0],
  'metrics.northwind.dev': [0, 0],
  '203.0.113.10': [0.04, 0],
  'scanner.invalid': [0.3, 0],
};

/** Standard normal CDF (Abramowitz–Stegun 7.1.26). */
function phi(z: number): number {
  const t = 1 / (1 + 0.3275911 * (Math.abs(z) / Math.SQRT2));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** `n` requests log-normally spread around `medianMs` (σ 0.8), as per-bucket counts. */
export function demoHistogram(medianMs: number, n: number): LatencyBuckets {
  const cdf = (s: number) => phi(Math.log((s * 1000) / medianMs) / 0.8);
  const cum = BOUNDS.map((b) => Math.round(n * cdf(b)));
  const total = Math.round(n);
  const counts = [...cum, total].map((c, i, all) => Math.max(0, c - (i > 0 ? all[i - 1]! : 0)));
  return { bounds: BOUNDS, counts };
}

export function medianFor(region: string | null, host: string): number {
  return (REGION_MEDIAN_MS[region ?? ''] ?? 80) * (HOST_FACTOR[host] ?? 1);
}

export function blockedShare(host: string): [number, number] {
  return BLOCKED_SHARE[host] ?? [0.002, 0];
}

/** Add p50/p95 (per edge, region, address, estate) and blocked a minute (per address) to a demo traffic.now. */
export function withDemoExtras(view: TrafficNowView): TrafficNowView {
  const regionOf = new Map(view.regions.flatMap((r) => r.edges.map((e) => [e.nodeId, r.region] as const)));
  const perEdge = new Map<string, LatencyBuckets>();
  const hosts = view.hosts.map((h) => {
    let hist: LatencyBuckets | undefined;
    for (const e of h.edges) {
      const one = demoHistogram(medianFor(regionOf.get(e.nodeId) ?? null, h.host), e.requestsPerMin * view.windowMinutes);
      hist = addLatency(hist, one);
      const merged = addLatency(perEdge.get(e.nodeId), one);
      if (merged) perEdge.set(e.nodeId, merged);
    }
    const [s403, s429] = blockedShare(h.host);
    const forbidden = round1(h.requestsPerMin * s403);
    const tooMany = round1(h.requestsPerMin * s429);
    return { ...h, ...latencyView(hist), blockedPerMin: round1(forbidden + tooMany), forbiddenPerMin: forbidden, tooManyPerMin: tooMany };
  });
  const merge = (ids: string[]) => latencyView(ids.reduce<LatencyBuckets | undefined>((acc, id) => addLatency(acc, perEdge.get(id)), undefined));
  const regions = view.regions.map((r) => ({
    ...r,
    ...merge(r.edges.map((e) => e.nodeId)),
    edges: r.edges.map((e) => ({ ...e, ...latencyView(perEdge.get(e.nodeId)) })),
  }));
  const reporting = view.totals.state === 'reporting';
  return {
    ...view,
    totals: { ...view.totals, ...merge([...perEdge.keys()]), blockedPerMin: reporting ? round1(hosts.reduce((n, h) => n + h.blockedPerMin, 0)) : null },
    regions,
    hosts,
  };
}
