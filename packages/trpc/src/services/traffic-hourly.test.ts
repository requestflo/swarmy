import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { EdgeTrafficRing, MINUTE_MS, TRAFFIC_HOUR_MS } from '@swarmy/core';
import { createTestDb, type TestDb } from '@swarmy/db';
import type { OrgContext } from '../context';
import { advanceTrafficHours, pruneTrafficHours } from './traffic-hourly';
import { trafficSeries } from './traffic-series';

// A Monday, 10:00 UTC. Two hours of 5-minute rows from one edge, then 20 minutes.
const H0 = Date.UTC(2026, 9, 19, 10);
const DAY = 24 * TRAFFIC_HOUR_MS;

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

async function writeFiveMinute(from: number, buckets: number, requests: number) {
  const data = Array.from({ length: buckets }, (_, i) => {
    const bucketStart = new Date(from + i * 5 * MINUTE_MS);
    return [
      { orgId: 'org', nodeId: 'eu1', region: 'eu', host: '', app: null, bucketStart, requests: 0, errors5xx: 0 },
      { orgId: 'org', nodeId: 'eu1', region: 'eu', host: 'shop.example.com', app: 'shop', bucketStart, requests, errors5xx: 1, status403: 2 },
    ];
  }).flat();
  await t.telemetry.edgeTrafficRollup.createMany({ data });
}

function ctx(): OrgContext {
  return {
    activeOrgId: 'org',
    telemetry: t.telemetry,
    hub: {
      edgeTraffic: () => new EdgeTrafficRing(),
      nodeInfoFor: () => ({ hostname: 'eu1', labels: { 'swarmy.region': 'eu' } }),
      liveInventory: () => ({ services: [], containers: [] }),
    },
  } as unknown as OrgContext;
}

describe('advanceTrafficHours — hourly rows from the 5-minute ones, never doubled', () => {
  it('folds only hours whose 5-minute rows are all flushed, and resumes after a restart', async () => {
    await writeFiveMinute(H0, 28, 600); // 10:00 … 12:15
    // Watermark at 12:20: 10:00 and 11:00 are complete; 12:00 is still filling.
    const mark = await advanceTrafficHours(t.telemetry, 'org', { flushedTo: H0 + 140 * MINUTE_MS, boot: H0 });
    expect(mark).toBe(H0 + 2 * TRAFFIC_HOUR_MS);
    const rows = await t.telemetry.edgeTrafficHourly.findMany({ orderBy: [{ bucketStart: 'asc' }, { host: 'asc' }] });
    expect(rows.map((r) => [r.bucketStart.getTime() - H0, r.host, r.requests, r.errors5xx, r.status403, r.app])).toEqual([
      [0, '', 0, 0, null, null],
      [0, 'shop.example.com', 7200, 12, 24, 'shop'],
      [TRAFFIC_HOUR_MS, '', 0, 0, null, null],
      [TRAFFIC_HOUR_MS, 'shop.example.com', 7200, 12, 24, 'shop'],
    ]);

    // A restart: no mark in memory, so it resumes after the newest folded hour.
    const again = await advanceTrafficHours(t.telemetry, 'org', { flushedTo: H0 + 140 * MINUTE_MS, boot: H0 + 130 * MINUTE_MS });
    expect(again).toBe(H0 + 2 * TRAFFIC_HOUR_MS);
    // Refolding an hour already folded (a stale mark) upserts the same numbers.
    await advanceTrafficHours(t.telemetry, 'org', { mark: H0, flushedTo: H0 + 140 * MINUTE_MS, boot: H0 });
    const after = await t.telemetry.edgeTrafficHourly.findMany({ where: { host: 'shop.example.com' } });
    expect(after.map((r) => r.requests)).toEqual([7200, 7200]);
  });

  it('backfills from the first whole hour the 5-minute table holds', async () => {
    await writeFiveMinute(H0 - 30 * MINUTE_MS, 18, 60); // 09:30 … 10:55
    const mark = await advanceTrafficHours(t.telemetry, 'org', { flushedTo: H0 + 2 * TRAFFIC_HOUR_MS, boot: H0 + 2 * TRAFFIC_HOUR_MS });
    expect(mark).toBe(H0 + 2 * TRAFFIC_HOUR_MS);
    const rows = await t.telemetry.edgeTrafficHourly.findMany({ where: { host: 'shop.example.com' } });
    expect(rows.map((r) => [r.bucketStart.getTime() - H0, r.requests])).toEqual([[0, 720]]);
  });

  it('prunes hourly rows past 35 days', async () => {
    await writeFiveMinute(H0, 12, 10);
    await advanceTrafficHours(t.telemetry, 'org', { flushedTo: H0 + TRAFFIC_HOUR_MS, boot: H0 });
    expect(await pruneTrafficHours(t.telemetry, H0 + 34 * DAY)).toBe(0);
    expect(await pruneTrafficHours(t.telemetry, H0 + 36 * DAY)).toBe(2);
  });
});

describe('traffic.series 28d — four weeks from the hourly rows, the rest from 5-minute rows', () => {
  it('reads folded hours, then the hour not folded yet from the 5-minute table', async () => {
    await writeFiveMinute(H0 - 20 * DAY, 12, 600); // three weeks ago: only hourly survives
    await advanceTrafficHours(t.telemetry, 'org', { flushedTo: H0 - 20 * DAY + TRAFFIC_HOUR_MS, boot: H0 });
    await t.telemetry.edgeTrafficRollup.deleteMany({}); // the 5-minute tier has aged out
    await writeFiveMinute(H0, 12, 300); // 10:00 hour, not folded yet
    const view = await trafficSeries(ctx(), { window: '28d' }, H0 + TRAFFIC_HOUR_MS + 5 * MINUTE_MS);
    expect(view.bucketSec).toBe(3600);
    expect(view.points).toHaveLength(672);
    const at = (ms: number) => view.points.find((p) => p.t === ms);
    expect(at(H0 - 20 * DAY)).toMatchObject({ requestsPerMin: 120, errors5xxPerMin: 0.2, blockedPerMin: 0.4 });
    expect(at(H0)).toMatchObject({ requestsPerMin: 60 });
    expect(at(H0 - TRAFFIC_HOUR_MS)!.requestsPerMin).toBeNull();
  });
});
