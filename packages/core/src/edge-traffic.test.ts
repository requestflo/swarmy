import { describe, expect, it } from 'bun:test';
import { parsePrometheusText } from './prometheus-text';
import {
  EDGE_OVERFLOW_HOST,
  EdgeTrafficRing,
  MINUTE_MS,
  aggregateTrafficNow,
  bucketTrafficSeries,
  caddyHostCounters,
  edgeTrafficDelta,
  makeHostAppResolver,
  normalizeTrafficHost,
  processStartTime,
  rollupRing,
  rollupWindow,
  type EdgeScrapeState,
  type HostCounter,
} from './edge-traffic';

// Golden Caddy 2.11 `/metrics` excerpt with `metrics { per_host }`: every
// request passes the site's `subroute` and then its terminal handler, so the
// same request appears in two handler series.
const CADDY_SCRAPE = `# TYPE caddy_http_requests_total counter
caddy_http_requests_total{handler="subroute",host="shop.example.com",server="srv0"} 1000
caddy_http_requests_total{handler="reverse_proxy",host="shop.example.com",server="srv0"} 990
caddy_http_requests_total{handler="static_response",host="shop.example.com",server="srv0"} 10
caddy_http_requests_total{handler="subroute",host="API.example.com:443",server="srv0"} 400
caddy_http_requests_total{handler="reverse_proxy",host="API.example.com:443",server="srv0"} 400
# TYPE caddy_http_request_duration_seconds histogram
caddy_http_request_duration_seconds_bucket{code="200",handler="subroute",host="shop.example.com",method="GET",server="srv0",le="0.005"} 500
caddy_http_request_duration_seconds_count{code="200",handler="subroute",host="shop.example.com",method="GET",server="srv0"} 960
caddy_http_request_duration_seconds_count{code="502",handler="subroute",host="shop.example.com",method="GET",server="srv0"} 30
caddy_http_request_duration_seconds_count{code="503",handler="subroute",host="shop.example.com",method="POST",server="srv0"} 10
caddy_http_request_duration_seconds_count{code="502",handler="reverse_proxy",host="shop.example.com",method="GET",server="srv0"} 30
caddy_http_request_duration_seconds_count{code="200",handler="subroute",host="api.example.com",method="GET",server="srv0"} 400
caddy_http_requests_total{handler="subroute",server="srv0"} 99999
process_start_time_seconds 1.7e+09
`;

const counters = (o: Record<string, [number, number]>): Map<string, HostCounter> =>
  new Map(Object.entries(o).map(([h, [requests, errors5xx]]) => [h, { requests, errors5xx }]));

describe('caddyHostCounters — golden Caddy scrape', () => {
  it('counts each request once (largest handler series), 5xx from the histogram codes, hosts normalised', () => {
    const c = caddyHostCounters(parsePrometheusText(CADDY_SCRAPE));
    expect(Object.fromEntries(c)).toEqual({
      'shop.example.com': { requests: 1000, errors5xx: 40 },
      'api.example.com': { requests: 400, errors5xx: 0 },
    });
  });

  it('uses the counter`s own code label when Caddy provides one', () => {
    const c = caddyHostCounters(
      parsePrometheusText(
        'caddy_http_requests_total{code="200",handler="subroute",host="a.test",server="s"} 90\n' +
          'caddy_http_requests_total{code="500",handler="subroute",host="a.test",server="s"} 10\n',
      ),
    );
    expect(c.get('a.test')).toEqual({ requests: 100, errors5xx: 10 });
  });

  it('falls back to the histogram count when the counter is absent', () => {
    const c = caddyHostCounters(
      parsePrometheusText('caddy_http_request_duration_seconds_count{code="504",handler="h",host="b.test",server="s"} 3\n'),
    );
    expect(c.get('b.test')).toEqual({ requests: 3, errors5xx: 3 });
  });

  it('reads the process start time', () => {
    expect(processStartTime(parsePrometheusText(CADDY_SCRAPE))).toBe(1.7e9);
    expect(normalizeTrafficHost('Shop.Example.COM.:8443')).toBe('shop.example.com');
    expect(normalizeTrafficHost('')).toBe('');
  });
});

describe('edgeTrafficDelta — deltas and counter resets', () => {
  const s = (at: number, c: Record<string, [number, number]>, startedAt?: number): EdgeScrapeState => ({
    at,
    counters: counters(c),
    ...(startedAt !== undefined ? { startedAt } : {}),
  });

  it('the first scrape is only a baseline', () => {
    expect(edgeTrafficDelta(undefined, s(1000, { 'a.test': [5, 0] }))).toBeUndefined();
  });

  it('reports per-host deltas since the previous scrape, omitting idle hosts', () => {
    const d = edgeTrafficDelta(
      s(0, { 'a.test': [100, 2], 'b.test': [50, 0] }),
      s(15_000, { 'a.test': [160, 5], 'b.test': [50, 0], 'c.test': [7, 1] }),
    );
    expect(d).toEqual({
      sampledAt: 15_000,
      intervalSec: 15,
      hosts: [
        { host: 'a.test', requests: 60, errors5xx: 3 },
        { host: 'c.test', requests: 7, errors5xx: 1 },
      ],
    });
  });

  it('an empty hosts list still reports ("edge up, no traffic")', () => {
    expect(edgeTrafficDelta(s(0, { 'a.test': [1, 0] }), s(5000, { 'a.test': [1, 0] }))?.hosts).toEqual([]);
  });

  it('a counter that went down restarted: its current value is the delta', () => {
    const d = edgeTrafficDelta(s(0, { 'a.test': [1000, 10] }), s(15_000, { 'a.test': [30, 1] }));
    expect(d?.hosts).toEqual([{ host: 'a.test', requests: 30, errors5xx: 1 }]);
  });

  it('a changed Caddy process start time resets every host even if counters grew past the old value', () => {
    const d = edgeTrafficDelta(s(0, { 'a.test': [10, 0] }, 1000), s(15_000, { 'a.test': [25, 0] }, 2000));
    expect(d?.hosts).toEqual([{ host: 'a.test', requests: 25, errors5xx: 0 }]);
  });

  it('no delta on a non-advancing clock', () => {
    expect(edgeTrafficDelta(s(5000, {}), s(5000, {}))).toBeUndefined();
  });

  it('folds hosts past the cap into the overflow host, never dropping requests', () => {
    const prev = s(0, {});
    const curr = s(1000, { 'a.test': [10, 0], 'b.test': [5, 1], 'c.test': [3, 0], 'd.test': [2, 2] });
    const d = edgeTrafficDelta(prev, curr, 3)!;
    expect(d.hosts).toEqual([
      { host: 'a.test', requests: 10, errors5xx: 0 },
      { host: 'b.test', requests: 5, errors5xx: 1 },
      { host: EDGE_OVERFLOW_HOST, requests: 5, errors5xx: 2 },
    ]);
  });
});

// A fixed clock: 2026-01-01T12:00:30Z.
const T0 = Date.UTC(2026, 0, 1, 12, 0, 30);
const M0 = Date.UTC(2026, 0, 1, 12, 0, 0);

describe('EdgeTrafficRing — 1-minute buckets, 6 h, injected clock', () => {
  it('buckets by the controller receive minute and keeps coverage separately from counts', () => {
    const ring = new EdgeTrafficRing();
    ring.record('org', 'edge-eu', { sampledAt: 1, intervalSec: 15, hosts: [{ host: 'a.test', requests: 30, errors5xx: 1 }] }, T0);
    ring.record('org', 'edge-eu', { sampledAt: 2, intervalSec: 15, hosts: [{ host: 'a.test', requests: 20, errors5xx: 0 }] }, T0 + 15_000);
    ring.record('org', 'edge-us', { sampledAt: 3, intervalSec: 15, hosts: [] }, T0 + 20_000);
    expect(ring.cells('org', M0, M0 + MINUTE_MS)).toEqual([
      { t: M0, nodeId: 'edge-eu', host: 'a.test', requests: 50, errors5xx: 1 },
    ]);
    expect([...ring.coverage('org', M0, M0 + MINUTE_MS).get(M0)!.keys()].sort()).toEqual(['edge-eu', 'edge-us']);
    expect(ring.reports('org').get('edge-eu')).toEqual({ firstAt: T0, lastAt: T0 + 15_000 });
    expect(ring.cells('other-org', 0, Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it('spreads a multi-minute delta by overlap (largest remainder, no requests lost)', () => {
    const ring = new EdgeTrafficRing();
    ring.record('org', 'n', { sampledAt: 1, intervalSec: 180, hosts: [{ host: 'a.test', requests: 10, errors5xx: 0 }] }, M0 + 2 * MINUTE_MS + 30_000);
    const cells = ring.cells('org', 0, Number.MAX_SAFE_INTEGER);
    // covers 11:59:30 → 12:02:30: 30 s, 60 s, 60 s, 30 s of four minutes
    expect(cells.map((c) => [c.t - M0, c.requests])).toEqual([
      [-MINUTE_MS, 2],
      [0, 3],
      [MINUTE_MS, 3],
      [2 * MINUTE_MS, 2],
    ]);
    const cov = ring.coverage('org', 0, Number.MAX_SAFE_INTEGER);
    expect([...cov.entries()].map(([m, n]) => [m - M0, n.get('n')])).toEqual([
      [-MINUTE_MS, 30_000],
      [0, MINUTE_MS],
      [MINUTE_MS, MINUTE_MS],
      [2 * MINUTE_MS, 30_000],
    ]);
  });

  it('prunes minutes older than 6 h', () => {
    const ring = new EdgeTrafficRing();
    ring.record('org', 'n', { sampledAt: 1, intervalSec: 15, hosts: [{ host: 'a.test', requests: 1, errors5xx: 0 }] }, T0);
    ring.record('org', 'n', { sampledAt: 2, intervalSec: 15, hosts: [{ host: 'a.test', requests: 2, errors5xx: 0 }] }, T0 + 360 * MINUTE_MS);
    expect(ring.cells('org', 0, Number.MAX_SAFE_INTEGER).map((c) => c.requests)).toEqual([2]);
  });
});

describe('rollups — 5-minute rows with coverage markers', () => {
  it('folds 1-minute cells into 5-minute rows per (edge, host), plus a coverage row per edge', () => {
    const ring = new EdgeTrafficRing();
    for (let i = 0; i < 6; i++) {
      ring.record('org', 'e1', { sampledAt: i, intervalSec: 60, hosts: [{ host: 'a.test', requests: 10, errors5xx: i === 5 ? 1 : 0 }] }, M0 + i * MINUTE_MS + 30_000);
    }
    ring.record('org', 'e2', { sampledAt: 9, intervalSec: 15, hosts: [] }, M0 + 30_000);
    expect(rollupRing(ring, 'org', M0, M0 + 5 * MINUTE_MS)).toEqual([
      { bucketStart: M0, nodeId: 'e1', host: '', requests: 0, errors5xx: 0 },
      { bucketStart: M0, nodeId: 'e1', host: 'a.test', requests: 50, errors5xx: 0 },
      { bucketStart: M0, nodeId: 'e2', host: '', requests: 0, errors5xx: 0 },
    ]);
  });

  it('flushes only whole buckets that ended a grace period ago, from the watermark on', () => {
    expect(rollupWindow(M0, M0 + 5 * MINUTE_MS + 10_000)).toBeUndefined();
    expect(rollupWindow(M0, M0 + 5 * MINUTE_MS + 30_000)).toEqual({ from: M0, to: M0 + 5 * MINUTE_MS });
    expect(rollupWindow(M0 + 60_000, M0 + 11 * MINUTE_MS)).toEqual({ from: M0 + 5 * MINUTE_MS, to: M0 + 10 * MINUTE_MS });
  });
});

describe('aggregateTrafficNow — to region and app', () => {
  const appOf = makeHostAppResolver([
    { host: 'shop.example.com', app: 'storefront' },
    { host: 'shop.example.com', app: 'checkout', path: '/pay' },
    { host: '*.preview.example.com', app: 'previews' },
    { host: 'api.example.com', app: 'storefront' },
  ]);
  const edges = [
    { nodeId: 'eu1', name: 'eu-1', region: 'eu-west' },
    { nodeId: 'eu2', name: 'eu-2', region: 'eu-west' },
    { nodeId: 'us1', name: 'us-1', region: 'us-east' },
    { nodeId: 'ap1', name: 'ap-1', region: 'ap-south' },
  ];

  it('resolves hosts: root route owner wins, wildcards match, unknown → null (other)', () => {
    expect(appOf('shop.example.com')).toBe('storefront');
    expect(appOf('pr-12.preview.example.com')).toBe('previews');
    expect(appOf('SHOP.example.com:443')).toBe('storefront');
    expect(appOf('random.test')).toBeNull();
  });

  it('rates per region and app over complete minutes, divides by each edge`s covered minutes, never drops "other"', () => {
    const now = M0 + 10 * MINUTE_MS + 20_000; // window = minutes 5..9
    const ring = new EdgeTrafficRing();
    for (let m = 0; m < 10; m++) {
      const at = M0 + m * MINUTE_MS + 30_000;
      ring.record('o', 'eu1', { sampledAt: at, intervalSec: 60, hosts: [{ host: 'shop.example.com', requests: 300, errors5xx: 3 }] }, at);
      ring.record('o', 'eu2', { sampledAt: at, intervalSec: 60, hosts: [{ host: 'api.example.com', requests: 100, errors5xx: 0 }, { host: 'junk.test', requests: 34, errors5xx: 0 }] }, at);
      // us1 only came up 2 minutes before the window closed.
      if (m >= 8) ring.record('o', 'us1', { sampledAt: at, intervalSec: 60, hosts: [{ host: 'shop.example.com', requests: 178, errors5xx: 0 }] }, at);
    }
    const view = aggregateTrafficNow({
      cells: ring.cells('o', 0, now),
      coverage: ring.coverage('o', 0, now),
      reports: ring.reports('o'),
      edges,
      appOf,
      now,
    });
    expect(view.windowMinutes).toBe(5);
    expect(view.sampledAt).toBe(M0 + 9 * MINUTE_MS + 30_000);
    expect(view.regions.map((r) => [r.region, r.requestsPerMin, r.state])).toEqual([
      ['eu-west', 434, 'reporting'],
      ['us-east', 178, 'reporting'],
      ['ap-south', null, 'no-data'],
    ]);
    expect(view.regions[0]!.edges.map((e) => [e.name, e.state, e.requestsPerMin])).toEqual([
      ['eu-1', 'reporting', 300],
      ['eu-2', 'reporting', 134],
    ]);
    expect(view.regions[2]!.edges).toEqual([
      { nodeId: 'ap1', name: 'ap-1', region: 'ap-south', state: 'no-data', requestsPerMin: null, lastReportAt: null },
    ]);
    expect(view.apps).toEqual([
      { app: 'storefront', requestsPerMin: 578, errors5xxPerMin: 3.1, errorShare: 0.0054, hosts: ['api.example.com', 'shop.example.com'] },
      { app: null, requestsPerMin: 34, errors5xxPerMin: 0, errorShare: 0, hosts: ['junk.test'] },
    ]);
    expect(view.totals).toEqual({ requestsPerMin: 612, errors5xxPerMin: 3.1, errorShare: 0.0051, state: 'reporting' });
  });

  it('nothing reported yet → no-data everywhere, never a zero', () => {
    const view = aggregateTrafficNow({ cells: [], coverage: new Map(), reports: new Map(), edges, appOf, now: T0 });
    expect(view.sampledAt).toBeNull();
    expect(view.totals).toEqual({ requestsPerMin: null, errors5xxPerMin: null, errorShare: null, state: 'no-data' });
    expect(view.regions.every((r) => r.requestsPerMin === null && r.state === 'no-data')).toBe(true);
    expect(view.apps).toEqual([]);
  });

  it('an edge silent for > 3 min reads stale; one that reports but is not a known edge is still listed', () => {
    const ring = new EdgeTrafficRing();
    ring.record('o', 'eu1', { sampledAt: 0, intervalSec: 60, hosts: [] }, M0 + 30_000);
    ring.record('o', 'ghost', { sampledAt: 0, intervalSec: 60, hosts: [] }, M0 + 9 * MINUTE_MS);
    const now = M0 + 10 * MINUTE_MS;
    const view = aggregateTrafficNow({ cells: [], coverage: ring.coverage('o', 0, now), reports: ring.reports('o'), edges, appOf, now });
    const all = view.regions.flatMap((r) => r.edges);
    expect(all.find((e) => e.nodeId === 'eu1')!.state).toBe('stale');
    expect(all.find((e) => e.nodeId === 'ghost')).toMatchObject({ region: null, state: 'reporting', requestsPerMin: 0 });
  });
});

describe('bucketTrafficSeries — sparkline buckets', () => {
  it('6h → 72 complete 5-minute buckets; gaps are null, quiet covered buckets are 0', () => {
    const now = M0 + 3 * 60_000; // last complete 5-min bucket ends at M0
    const out = bucketTrafficSeries({
      rows: [
        { t: M0 - 5 * MINUTE_MS, nodeId: 'e', host: 'a.test', requests: 500, errors5xx: 5 },
        { t: M0 - 4 * MINUTE_MS, nodeId: 'e', host: 'a.test', requests: 500, errors5xx: 0 },
        { t: M0, nodeId: 'e', host: 'a.test', requests: 999, errors5xx: 0 }, // partial bucket: excluded
      ],
      coveredAt: [M0 - 10 * MINUTE_MS],
      window: '6h',
      now,
    });
    expect(out.bucketSec).toBe(300);
    expect(out.points).toHaveLength(72);
    expect(out.points.at(-1)).toEqual({ t: M0 - 5 * MINUTE_MS, requestsPerMin: 200, errors5xxPerMin: 1 });
    expect(out.points.at(-2)).toEqual({ t: M0 - 10 * MINUTE_MS, requestsPerMin: 0, errors5xxPerMin: 0 });
    expect(out.points.at(-3)!.requestsPerMin).toBeNull();
    expect(out.points[0]!.t).toBe(M0 - 6 * 60 * MINUTE_MS);
  });

  it('24h → 96 x 15 min, 7d → 168 x 1 h', () => {
    expect(bucketTrafficSeries({ rows: [], coveredAt: [], window: '24h', now: T0 }).points).toHaveLength(96);
    const week = bucketTrafficSeries({ rows: [], coveredAt: [], window: '7d', now: T0 });
    expect(week.bucketSec).toBe(3600);
    expect(week.points).toHaveLength(168);
  });
});
