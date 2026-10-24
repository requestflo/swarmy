import { describe, expect, it } from 'bun:test';
import { EdgeTrafficRing, MINUTE_MS, aggregateTrafficNow, bucketTrafficSeries, rollupRing } from './edge-traffic';
import { apportionExtras } from './edge-traffic-extras';

const M0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const B = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const at = (i: number, n: number) => {
  const c = new Array<number>(B.length + 1).fill(0);
  c[i] = n;
  return { bounds: B, counts: c };
};
const edges = [
  { nodeId: 'eu1', name: 'eu-1', region: 'eu-west' },
  { nodeId: 'us1', name: 'us-1', region: 'us-east' },
  { nodeId: 'old', name: 'old-agent', region: 'us-east' },
];
const appOf = () => 'shop';

/** Ten whole minutes: eu1 serves shop fast and busy, us1 serves shop slow and quiet, `old` predates the extras. */
function ring(): EdgeTrafficRing {
  const r = new EdgeTrafficRing();
  for (let m = 0; m < 10; m++) {
    const t = M0 + (m + 1) * MINUTE_MS; // each report covers exactly minute m
    r.record('o', 'eu1', {
      sampledAt: t,
      intervalSec: 60,
      hosts: [
        { host: 'shop.test', requests: 900, errors5xx: 0, status403: 6, status429: 3, latency: at(0, 900) },
        { host: 'api.test', requests: 100, errors5xx: 0, status403: 0, status429: 0, latency: at(4, 100) },
      ],
    }, t);
    r.record('o', 'us1', { sampledAt: t, intervalSec: 60, hosts: [{ host: 'shop.test', requests: 100, errors5xx: 0, status403: 1, status429: 0, latency: at(7, 100) }] }, t);
    r.record('o', 'old', { sampledAt: t, intervalSec: 60, hosts: [{ host: 'legacy.test', requests: 50, errors5xx: 0 }] }, t);
  }
  return r;
}

describe('traffic.now — p50/p95 per edge and per host from merged buckets', () => {
  const r = ring();
  const now = M0 + 10 * MINUTE_MS + 20_000;
  const view = aggregateTrafficNow({ cells: r.cells('o', 0, now), coverage: r.coverage('o', 0, now), reports: r.reports('o'), edges, appOf, now });
  const edge = (id: string) => view.regions.flatMap((x) => x.edges).find((e) => e.nodeId === id)!;
  const host = (h: string) => view.hosts.find((x) => x.host === h)!;

  it('an edge`s percentiles merge every host it carried; an older agent reads null, never 0', () => {
    expect(edge('eu1')).toMatchObject({ p50Ms: 2.8, p95Ms: 75 });
    expect(edge('us1')).toMatchObject({ p50Ms: 750, p95Ms: 975 });
    expect(edge('old')).toMatchObject({ requestsPerMin: 50, p50Ms: null, p95Ms: null });
  });

  it('a host merges its buckets across edges (not an average of edge percentiles)', () => {
    // 900 fast on eu1 + 100 slow on us1: the median request is a fast one.
    expect(host('shop.test')).toMatchObject({ p50Ms: 2.8, p95Ms: 750 });
    expect(view.regions.find((x) => x.region === 'us-east')).toMatchObject({ p50Ms: 750 });
    expect(view.totals).toMatchObject({ p50Ms: 3.1, p95Ms: 725 });
  });

  it('blocked a minute = 403 + 429 at the host, summed over edges; unreported stays null', () => {
    expect(host('shop.test')).toMatchObject({ blockedPerMin: 10, forbiddenPerMin: 7, tooManyPerMin: 3 });
    expect(host('api.test')).toMatchObject({ blockedPerMin: 0, forbiddenPerMin: 0, tooManyPerMin: 0 });
    expect(host('legacy.test')).toMatchObject({ blockedPerMin: null, forbiddenPerMin: null, tooManyPerMin: null });
    expect(view.totals.blockedPerMin).toBe(10);
  });
});

describe('rollups and series keep the bucket counts', () => {
  it('host rows carry their own buckets and 403/429; the coverage row carries the whole edge', () => {
    const rows = rollupRing(ring(), 'o', M0, M0 + 5 * MINUTE_MS);
    const row = (nodeId: string, host: string) => rows.find((x) => x.nodeId === nodeId && x.host === host)!;
    expect(row('eu1', 'shop.test')).toMatchObject({ requests: 4500, status403: 30, status429: 15, latency: at(0, 4500) });
    const cover = row('eu1', '');
    expect(cover).toMatchObject({ requests: 0, errors5xx: 0 });
    expect(cover.latency!.counts[0]).toBe(4500);
    expect(cover.latency!.counts[4]).toBe(500);
    expect(row('old', '').latency).toBeUndefined();
  });

  it('a series point merges its rows` buckets and reads blocked a minute', () => {
    const out = bucketTrafficSeries({
      rows: [
        { t: M0 - 5 * MINUTE_MS, nodeId: 'eu1', host: '', requests: 0, errors5xx: 0, latency: at(0, 900) },
        { t: M0 - 5 * MINUTE_MS, nodeId: 'us1', host: '', requests: 0, errors5xx: 0, latency: at(7, 100) },
        { t: M0 - 4 * MINUTE_MS, nodeId: 'eu1', host: 'shop.test', requests: 1000, errors5xx: 0, status403: 40, status429: 10 },
      ],
      coveredAt: [M0 - 10 * MINUTE_MS],
      window: '6h',
      now: M0 + 60_000,
    });
    expect(out.points.at(-1)).toMatchObject({ requestsPerMin: 200, p50Ms: 2.8, p95Ms: 750, blockedPerMin: 10 });
    expect(out.points.at(-2)).toMatchObject({ requestsPerMin: 0, p50Ms: null, blockedPerMin: null });
    expect(out.points.at(-3)).toMatchObject({ requestsPerMin: null, blockedPerMin: null });
  });
});

describe('apportionExtras', () => {
  it('splits 403/429 and buckets over the minutes; absent fields stay absent', () => {
    const parts = apportionExtras({ host: 'x', requests: 4, errors5xx: 0, status403: 3, latency: at(2, 4) }, [1, 1]);
    expect(parts.map((p) => p.status403)).toEqual([1, 2]);
    expect(parts.every((p) => p.status429 === undefined)).toBe(true);
    expect(parts.map((p) => p.latency!.counts[2])).toEqual([2, 2]);
    expect(apportionExtras({ host: 'x', requests: 1, errors5xx: 0 }, [1])).toEqual([{}]);
  });
});
