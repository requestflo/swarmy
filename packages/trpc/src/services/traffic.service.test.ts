import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import { EdgeTrafficRing, MINUTE_MS } from '@swarmy/core';
import { createTestDb, type TestDb } from '@swarmy/db';
import type { OrgContext } from '../context';
import { flushTrafficRollups, pruneTrafficRollups, trafficNow, trafficSeries } from './traffic.service';

const M0 = Date.UTC(2026, 0, 1, 12, 0, 0);

function svc(name: string, stack: string, hosts: string[]): SwarmServiceInfo {
  return {
    id: name,
    name,
    image: 'x:1',
    mode: 'replicated',
    desiredReplicas: 1,
    runningReplicas: 1,
    createdAt: 0,
    updatedAt: 0,
    labels: {
      'com.docker.stack.namespace': stack,
      'swarmy.ingress.routes': JSON.stringify(hosts.map((host) => ({ host, port: 80 }))),
    },
    networks: [],
    env: [],
    ports: [],
    secrets: [],
    configs: [],
  };
}

const REGION: Record<string, string> = { eu1: 'eu-west', us1: 'us-east', ap1: 'ap-south' };

function ctxWith(ring: EdgeTrafficRing | undefined, t: TestDb): OrgContext {
  return {
    activeOrgId: 'org',
    telemetry: t.telemetry,
    db: {
      node: {
        findMany: async () => [
          { id: 'eu1', name: 'edge-eu' },
          { id: 'us1', name: 'edge-us' },
          { id: 'ap1', name: 'edge-ap' },
        ],
      },
    },
    hub: {
      ...(ring ? { edgeTraffic: () => ring } : {}),
      isOnline: () => false,
      latestContainers: () => [],
      nodesByRole: () => ['eu1', 'us1', 'ap1'],
      nodeInfoFor: (id: string) => ({ hostname: id, labels: { 'swarmy.region': REGION[id] } }),
      liveInventory: () => ({
        services: [svc('shop_web', 'shop', ['shop.example.com']), svc('blog_ghost', 'blog', ['blog.example.com'])],
        containers: [],
      }),
    },
  } as unknown as OrgContext;
}

function feed(ring: EdgeTrafficRing, minutes: number) {
  for (let m = 0; m < minutes; m++) {
    const at = M0 + m * MINUTE_MS + 30_000;
    ring.record('org', 'eu1', { sampledAt: at, intervalSec: 60, hosts: [
      { host: 'shop.example.com', requests: 400, errors5xx: 4 },
      { host: 'scanner.test', requests: 34, errors5xx: 0 },
    ] }, at);
    ring.record('org', 'us1', { sampledAt: at, intervalSec: 60, hosts: [{ host: 'blog.example.com', requests: 178, errors5xx: 0 }] }, at);
  }
}

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

describe('traffic.now — ring → region / app via live labels and routes', () => {
  it('maps edges to regions and hosts to apps; unknown hosts go to "other"; a silent edge is no-data', async () => {
    const ring = new EdgeTrafficRing();
    feed(ring, 12);
    const view = await trafficNow(ctxWith(ring, t), M0 + 12 * MINUTE_MS);
    expect(view.regions.map((r) => [r.region, r.requestsPerMin, r.state, r.edges.map((e) => e.name)])).toEqual([
      ['eu-west', 434, 'reporting', ['edge-eu']],
      ['us-east', 178, 'reporting', ['edge-us']],
      ['ap-south', null, 'no-data', ['edge-ap']],
    ]);
    expect(view.apps.map((a) => [a.app, a.requestsPerMin, a.errorShare, a.hosts])).toEqual([
      ['shop', 400, 0.01, ['shop.example.com']],
      ['blog', 178, 0, ['blog.example.com']],
      [null, 34, 0, ['scanner.test']],
    ]);
    expect(view.totals.requestsPerMin).toBe(612);
  });

  it('a hub without the ring (older/demo) reads "no data yet", not zero', async () => {
    const view = await trafficNow(ctxWith(undefined, t), M0);
    expect(view.totals).toMatchObject({ requestsPerMin: null, state: 'no-data' });
    expect(view.regions.every((r) => r.edges.every((e) => e.state === 'no-data'))).toBe(true);
  });
});

describe('rollups — flush, series from rollups + ring tail, prune', () => {
  it('flushes 5-minute rows (with region/app), is idempotent, and series reads them back', async () => {
    const ring = new EdgeTrafficRing();
    feed(ring, 12);
    const ctx = ctxWith(ring, t);
    const n = await flushTrafficRollups(ctx, ring, { from: M0, to: M0 + 10 * MINUTE_MS });
    expect(n).toBeGreaterThan(0);
    await flushTrafficRollups(ctx, ring, { from: M0, to: M0 + 10 * MINUTE_MS });
    const rows = await t.telemetry.edgeTrafficRollup.findMany({ where: { bucketStart: new Date(M0 + 5 * MINUTE_MS) }, orderBy: [{ nodeId: 'asc' }, { host: 'asc' }] });
    expect(rows.map((r) => [r.nodeId, r.host, r.region, r.app, r.requests])).toEqual([
      ['eu1', '', 'eu-west', null, 0],
      ['eu1', 'scanner.test', 'eu-west', null, 170],
      ['eu1', 'shop.example.com', 'eu-west', 'shop', 2000],
      ['us1', '', 'us-east', null, 0],
      ['us1', 'blog.example.com', 'us-east', 'blog', 890],
    ]);

    // Clock at 12:15 → last complete 5-min bucket is 12:10 (from the ring tail).
    const now = M0 + 15 * MINUTE_MS + 10_000;
    const all = await trafficSeries(ctx, { window: '6h' }, now);
    expect(all.bucketSec).toBe(300);
    expect(all.points).toHaveLength(72);
    // 11:55 never flushed (gap), 12:00 + 12:05 from rollups, 12:10 from the ring
    // tail: minute 10 full, minute 11 half (its second half arrives with the
    // next sample), minutes 12-14 silent → (612 + 306) / 5.
    expect(all.points.slice(-4).map((p) => p.requestsPerMin)).toEqual([null, 612, 612, 183.6]);
    const shop = await trafficSeries(ctx, { window: '6h', app: 'shop' }, now);
    expect(shop.points.at(-3)!.requestsPerMin).toBe(400);
    const other = await trafficSeries(ctx, { window: '6h', app: null }, now);
    expect(other.points.at(-3)!.requestsPerMin).toBe(34);
    const us = await trafficSeries(ctx, { window: '6h', region: 'us-east' }, now);
    expect(us.points.at(-3)!.requestsPerMin).toBe(178);
    expect(us.points.at(-5)!.requestsPerMin).toBeNull();

    // Prune: nothing is 7 days old yet; 8 days on, everything goes.
    expect(await pruneTrafficRollups(t.telemetry, now)).toBe(0);
    expect(await pruneTrafficRollups(t.telemetry, now + 8 * 24 * 60 * MINUTE_MS)).toBe(rows.length * 2);
  });
});
