import { describe, expect, it } from 'bun:test';
import { EDGE_OVERFLOW_HOST, EdgeTrafficRing, MINUTE_MS, aggregateTrafficNow, makeHostAppResolver } from './edge-traffic';
import { aggregateTrafficHosts } from './edge-traffic-hosts';

const M0 = Date.UTC(2026, 9, 24, 12, 0, 0);
const appOf = makeHostAppResolver([
  { host: 'shop.example.com', app: 'storefront' },
  { host: 'api.example.com', app: 'storefront' },
]);
const edges = [
  { nodeId: 'eu1', name: 'eu-1', region: 'eu-west' },
  { nodeId: 'us1', name: 'us-1', region: 'us-east' },
];

describe('traffic.now per host', () => {
  it('rates each address on its own, split by edge; an app`s hosts add up to the app', () => {
    const now = M0 + 10 * MINUTE_MS + 20_000; // window = minutes 5..9
    const ring = new EdgeTrafficRing();
    for (let m = 0; m < 10; m++) {
      const at = M0 + m * MINUTE_MS + 30_000;
      ring.record('o', 'eu1', {
        sampledAt: at,
        intervalSec: 60,
        hosts: [
          { host: 'shop.example.com', requests: 300, errors5xx: 3 },
          { host: 'api.example.com', requests: 100, errors5xx: 0 },
          { host: EDGE_OVERFLOW_HOST, requests: 7, errors5xx: 1 },
        ],
      }, at);
      // us1 came up 2 minutes before the window closed: its rate is over those 2 minutes.
      if (m >= 8) ring.record('o', 'us1', { sampledAt: at, intervalSec: 60, hosts: [{ host: 'shop.example.com', requests: 178, errors5xx: 0 }] }, at);
    }
    const view = aggregateTrafficNow({ cells: ring.cells('o', 0, now), coverage: ring.coverage('o', 0, now), reports: ring.reports('o'), edges, appOf, now });
    // No status codes or duration buckets in these (older-agent) payloads: null, never a zero.
    const none = { blockedPerMin: null, forbiddenPerMin: null, tooManyPerMin: null, p50Ms: null, p95Ms: null };
    expect(view.hosts).toEqual([
      {
        host: 'shop.example.com',
        app: 'storefront',
        requestsPerMin: 478,
        errors5xxPerMin: 3.1,
        errorShare: 0.0065,
        ...none,
        edges: [
          { nodeId: 'eu1', requestsPerMin: 300 },
          { nodeId: 'us1', requestsPerMin: 178 },
        ],
      },
      { host: 'api.example.com', app: 'storefront', requestsPerMin: 100, errors5xxPerMin: 0, errorShare: 0, ...none, edges: [{ nodeId: 'eu1', requestsPerMin: 100 }] },
      // The hosts an edge folded past its cap stay one honest row, owned by no app.
      { host: EDGE_OVERFLOW_HOST, app: null, requestsPerMin: 7.1, errors5xxPerMin: 1.1, errorShare: 0.1563, ...none, edges: [{ nodeId: 'eu1', requestsPerMin: 7.1 }] },
    ]);
    const storefront = view.apps.find((a) => a.app === 'storefront')!;
    const hostsSum = view.hosts.filter((h) => h.app === 'storefront').reduce((n, h) => n + h.requestsPerMin, 0);
    expect(hostsSum).toBe(storefront.requestsPerMin);
  });

  it('nothing reported → no hosts (never a zero row)', () => {
    expect(aggregateTrafficNow({ cells: [], coverage: new Map(), reports: new Map(), edges, appOf, now: M0 }).hosts).toEqual([]);
  });

  it('drops cells outside the window and from an edge with no covered minute', () => {
    const cell = (t: number, nodeId: string) => ({ t, nodeId, host: 'shop.example.com', requests: 60, errors5xx: 0 });
    const hosts = aggregateTrafficHosts({
      cells: [cell(M0, 'eu1'), cell(M0 - MINUTE_MS, 'eu1'), cell(M0 + 5 * MINUTE_MS, 'eu1'), cell(M0, 'ghost')],
      covered: new Map([['eu1', 1]]),
      appOf,
      start: M0,
      end: M0 + 5 * MINUTE_MS,
    });
    expect(hosts.map((h) => [h.host, h.requestsPerMin, h.edges.length])).toEqual([['shop.example.com', 60, 1]]);
  });
});
