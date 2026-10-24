import { describe, expect, it } from 'bun:test';
import { parsePrometheusText } from './prometheus-text';
import { caddyHostCounters, edgeTrafficDelta, type EdgeScrapeState } from './edge-traffic';
import { caddyHostExtras, hostExtrasDelta, withEdgeExtras } from './edge-traffic-caddy';

const LE = ['0.005', '0.01', '0.025', '0.05', '0.1', '0.25', '0.5', '1', '2.5', '5', '10', '+Inf'];
const B = LE.slice(0, -1).map(Number);

/** One histogram series as Caddy 2.11.4 prints it (cumulative buckets, then _sum and _count). */
function series(host: string, code: string, cum: number[], handler = 'subroute'): string {
  const l = `code="${code}",handler="${handler}",host="${host}",method="GET",server="srv0"`;
  return [
    ...LE.map((le, i) => `caddy_http_request_duration_seconds_bucket{${l},le="${le}"} ${cum[i]}`),
    `caddy_http_request_duration_seconds_sum{${l}} 0.0019`,
    `caddy_http_request_duration_seconds_count{${l}} ${cum.at(-1)}`,
  ].join('\n');
}
const flat = (n: number, from = 0) => LE.map((_, i) => (i >= from ? n : 0));

/**
 * Captured from a real caddy 2.11.4 edge (swarmy's render: `metrics { per_host }`,
 * scanner paths → `respond 403`, bots → `abort`, a 429 stand-in for rate_limit):
 * shop.local served 2 ok, 1 scanner path, 1 rate-limited, and 1 bot that was
 * aborted — which Caddy never counts (requests_total is 4, not 5).
 */
const SCRAPE_1 = `# TYPE caddy_http_request_duration_seconds histogram
${series('shop.local', '200', flat(2))}
${series('shop.local', '403', flat(1))}
${series('shop.local', '429', flat(1))}
${series('api.local', '200', flat(1))}
# TYPE caddy_http_requests_total counter
caddy_http_requests_total{handler="subroute",host="api.local",server="srv0"} 1
caddy_http_requests_total{handler="subroute",host="shop.local",server="srv0"} 4
process_start_time_seconds 1.79284059136e+09
`;

describe('caddyHostExtras — 403/429 and duration buckets out of a real Caddy scrape', () => {
  it('reads codes off the histogram count (the counter has none) and sums buckets over codes', () => {
    const x = caddyHostExtras(parsePrometheusText(SCRAPE_1));
    expect(x.get('shop.local')!.status403).toBe(1);
    expect(x.get('shop.local')!.status429).toBe(1);
    expect([...x.get('shop.local')!.cumulative.values()]).toEqual(flat(4));
    expect(x.get('shop.local')!.cumulative.get(Number.POSITIVE_INFINITY)).toBe(4);
    expect(x.get('api.local')).toMatchObject({ status403: 0, status429: 0 });
  });

  it('takes the busiest handler (never sums handlers) and leaves 101 upgrades out of the buckets', () => {
    const text = [
      series('ws.local', '200', flat(10)),
      series('ws.local', '200', flat(10), 'reverse_proxy'),
      series('ws.local', '101', flat(5, 11)), // a WebSocket's "duration" is the whole connection
    ].join('\n');
    const x = caddyHostExtras(parsePrometheusText(text)).get('ws.local')!;
    expect(x.cumulative.get(0.005)).toBe(10);
    expect(x.cumulative.get(Number.POSITIVE_INFINITY)).toBe(10);
  });
});

describe('hostExtrasDelta — counters to deltas, cumulative to per-bucket', () => {
  const ex = (s403: number, s429: number, cum: number[]) => ({
    status403: s403,
    status429: s429,
    cumulative: new Map(LE.map((le, i) => [le === '+Inf' ? Number.POSITIVE_INFINITY : Number(le), cum[i]!] as const)),
  });

  it('subtracts the previous scrape and spreads cumulative counts into buckets', () => {
    const d = hostExtrasDelta(ex(1, 0, flat(4)), ex(3, 1, [6, 6, 6, 7, 7, 7, 7, 7, 7, 7, 7, 8]));
    expect(d).toEqual({ status403: 2, status429: 1, latency: { bounds: B, counts: [2, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1] } });
  });

  it('a value that went down means the series restarted: the current values are the delta', () => {
    const d = hostExtrasDelta(ex(9, 9, flat(50)), ex(1, 0, flat(2)));
    expect(d.status403).toBe(1);
    expect(d.latency!.counts[0]).toBe(2);
    expect(hostExtrasDelta(ex(0, 0, flat(1)), ex(0, 0, flat(1)))).toEqual({ status403: 0, status429: 0 });
  });
});

describe('withEdgeExtras — the metrics.edge payload carries them, additively', () => {
  const state = (text: string, at: number): EdgeScrapeState => {
    const s = parsePrometheusText(text);
    return { at, startedAt: 1, counters: caddyHostCounters(s), extras: caddyHostExtras(s) };
  };
  const SCRAPE_2 = SCRAPE_1.replace(
    series('shop.local', '403', flat(1)),
    series('shop.local', '403', [3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3]),
  ).replace('host="shop.local",server="srv0"} 4', 'host="shop.local",server="srv0"} 6');

  it('adds each host`s 403/429 and buckets since the last scrape', () => {
    const prev = state(SCRAPE_1, 0);
    const curr = state(SCRAPE_2, 15_000);
    const out = withEdgeExtras(edgeTrafficDelta(prev, curr), prev, curr)!;
    expect(out.hosts).toEqual([
      { host: 'shop.local', requests: 2, errors5xx: 0, status403: 2, status429: 0, latency: { bounds: B, counts: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } },
    ]);
  });

  it('folds an over-cap host into _other and never reports more blocked than requests', () => {
    const prev = state(SCRAPE_1, 0);
    const curr = state(SCRAPE_2.replace('host="api.local",server="srv0"} 1', 'host="api.local",server="srv0"} 2'), 15_000);
    const capped = edgeTrafficDelta(prev, curr, 1)!;
    expect(capped.hosts.map((h) => h.host)).toEqual(['_other']);
    const out = withEdgeExtras(capped, prev, curr)!;
    expect(out.hosts[0]).toMatchObject({ host: '_other', requests: 3, status403: 2, status429: 0 });
    const lying = withEdgeExtras({ sampledAt: 0, intervalSec: 15, hosts: [{ host: 'shop.local', requests: 1, errors5xx: 0 }] }, prev, curr)!;
    expect(lying.hosts[0]!.status403).toBe(1);
  });

  it('first scrape, or a scrape with no histogram, passes the sample through untouched', () => {
    const curr = state(SCRAPE_1, 0);
    expect(withEdgeExtras(undefined, undefined, curr)).toBeUndefined();
    const sample = { sampledAt: 0, intervalSec: 15, hosts: [{ host: 'x', requests: 1, errors5xx: 0 }] };
    expect(withEdgeExtras(sample, curr, { at: 1, counters: new Map() })).toBe(sample);
  });
});
