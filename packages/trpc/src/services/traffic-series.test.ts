import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { EdgeTrafficRing, MINUTE_MS } from '@swarmy/core';
import { createTestDb, type TestDb } from '@swarmy/db';
import type { OrgContext } from '../context';
import { flushTrafficRollups, trafficNow } from './traffic.service';
import { trafficSeries } from './traffic-series';

const M0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const B = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const at = (i: number, n: number) => ({ bounds: B, counts: B.map((_, k) => (k === i ? n : 0)).concat(i === B.length ? n : 0) });
const REGION: Record<string, string> = { eu1: 'eu-west', us1: 'us-east' };

function ctxWith(ring: EdgeTrafficRing, t: TestDb): OrgContext {
  const routes = (host: string) => JSON.stringify([{ host, port: 80 }]);
  return {
    activeOrgId: 'org',
    telemetry: t.telemetry,
    db: { node: { findMany: async () => [{ id: 'eu1', name: 'edge-eu' }, { id: 'us1', name: 'edge-us' }] } },
    hub: {
      edgeTraffic: () => ring,
      isOnline: () => false,
      latestContainers: () => [],
      nodesByRole: () => ['eu1', 'us1'],
      nodeInfoFor: (id: string) => ({ hostname: id, labels: { 'swarmy.region': REGION[id] } }),
      liveInventory: () => ({
        services: [
          { id: 'w', name: 'shop_web', labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.ingress.routes': routes('shop.example.com') } },
          { id: 'b', name: 'blog_ghost', labels: { 'com.docker.stack.namespace': 'blog', 'swarmy.ingress.routes': routes('blog.example.com') } },
        ],
        containers: [],
      }),
    },
  } as unknown as OrgContext;
}

/** Whole minutes: eu1 serves shop fast with some blocked answers, us1 serves blog slow. */
function feed(ring: EdgeTrafficRing, minutes: number) {
  for (let m = 0; m < minutes; m++) {
    const t = M0 + (m + 1) * MINUTE_MS;
    ring.record('org', 'eu1', { sampledAt: t, intervalSec: 60, hosts: [
      { host: 'shop.example.com', requests: 900, errors5xx: 0, status403: 8, status429: 2, latency: at(0, 900) },
    ] }, t);
    ring.record('org', 'us1', { sampledAt: t, intervalSec: 60, hosts: [
      { host: 'blog.example.com', requests: 100, errors5xx: 0, status403: 0, status429: 0, latency: at(7, 100) },
    ] }, t);
  }
}

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

describe('traffic.now — p50/p95 per edge and host, blocked a minute per host', () => {
  it('reads them off the ring for each edge, region, host and the whole estate', async () => {
    const ring = new EdgeTrafficRing();
    feed(ring, 12);
    const view = await trafficNow(ctxWith(ring, t), M0 + 12 * MINUTE_MS + 5_000);
    const edges = view.regions.flatMap((r) => r.edges.map((e) => [e.name, e.p50Ms, e.p95Ms]));
    expect(edges).toEqual([['edge-eu', 2.5, 4.8], ['edge-us', 750, 975]]);
    expect(view.totals).toMatchObject({ p50Ms: 2.8, p95Ms: 750, blockedPerMin: 10 });
    expect(view.hosts.map((h) => [h.host, h.blockedPerMin, h.forbiddenPerMin, h.tooManyPerMin])).toEqual([
      ['shop.example.com', 10, 8, 2],
      ['blog.example.com', 0, 0, 0],
    ]);
  });
});

describe('traffic.series — rollups keep the bucket counts; per address and per edge', () => {
  it('flushes 403/429 and buckets, and reads them back merged for the estate, an app, a host or an edge', async () => {
    const ring = new EdgeTrafficRing();
    feed(ring, 12);
    const ctx = ctxWith(ring, t);
    await flushTrafficRollups(ctx, ring, { from: M0, to: M0 + 10 * MINUTE_MS });
    const cover = await t.telemetry.edgeTrafficRollup.findFirst({ where: { nodeId: 'eu1', host: '', bucketStart: new Date(M0) } });
    expect(cover).toMatchObject({ requests: 0, status403: null, durationBuckets: JSON.stringify({ b: B, c: at(0, 4500).counts }) });
    const shopRow = await t.telemetry.edgeTrafficRollup.findFirst({ where: { host: 'shop.example.com', bucketStart: new Date(M0) } });
    expect(shopRow).toMatchObject({ requests: 4500, status403: 40, status429: 10 });

    const now = M0 + 15 * MINUTE_MS + 10_000;
    // 12:00 and 12:05 come from rollups, 12:10 from the ring tail (minutes 10 and 11 of 5).
    const all = await trafficSeries(ctx, { window: '6h' }, now);
    expect(all.points.slice(-3).map((p) => [p.p50Ms, p.p95Ms, p.blockedPerMin])).toEqual([
      [2.8, 750, 10],
      [2.8, 750, 10],
      [2.8, 750, 4],
    ]);
    const blog = await trafficSeries(ctx, { window: '6h', host: 'BLOG.example.com' }, now);
    expect(blog.host).toBe('blog.example.com');
    expect(blog.points.slice(-3).map((p) => [p.requestsPerMin, p.p50Ms, p.blockedPerMin])).toEqual([[100, 750, 0], [100, 750, 0], [40, 750, 0]]);
    const shop = await trafficSeries(ctx, { window: '6h', app: 'shop' }, now);
    expect(shop.points.at(-2)).toMatchObject({ requestsPerMin: 900, p50Ms: 2.5, blockedPerMin: 10 });
    const us = await trafficSeries(ctx, { window: '6h', nodeId: 'us1' }, now);
    expect(us.nodeId).toBe('us1');
    expect(us.points.at(-2)).toMatchObject({ requestsPerMin: 100, p50Ms: 750, blockedPerMin: 0 });
    expect(us.points.at(-4)).toMatchObject({ requestsPerMin: null, p50Ms: null, blockedPerMin: null });
  });
});
