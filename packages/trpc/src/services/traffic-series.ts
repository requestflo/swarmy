import {
  TRAFFIC_HOUR_MS,
  TRAFFIC_ROLLUP_MS,
  TRAFFIC_WINDOWS,
  bucketTrafficSeries,
  normalizeTrafficHost,
  type TrafficSeriesInput,
  type TrafficSeriesRow,
  type TrafficSeriesView,
} from '@swarmy/core';
import { telemetryOf, type OrgContext } from '../context';
import { regionOf, ringOf, trafficAppResolver } from './traffic.service';
import { readRollups, rollupTable, type RollupFilter } from './traffic-series-read';

/**
 * traffic.series — sparkline buckets. Persisted 5-minute rollups for the
 * span, topped up from the in-memory ring for the minutes not flushed yet
 * (and for everything after a controller restart until rollups catch up).
 * The four-week window (`28d`) reads the hourly rollups first (the 5-minute
 * ones keep 7 days), then 5-minute rows for the hours not folded yet, then
 * the ring.
 *
 * Narrow by app, region, one address (`host`) or one edge (`nodeId`). Each
 * point carries p50/p95 from the MERGED duration buckets of everything it
 * covers and blocked (403 + 429) a minute. An edge-wide latency comes from
 * the coverage rows (each edge's whole histogram); an app or address reads
 * its own host rows.
 */
export async function trafficSeries(
  ctx: OrgContext,
  input: TrafficSeriesInput,
  now = Date.now(),
): Promise<TrafficSeriesView> {
  const orgId = ctx.activeOrgId;
  const { spanMs, bucketMs } = TRAFFIC_WINDOWS[input.window];
  const start = Math.floor(now / bucketMs) * bucketMs - spanMs;
  const tdb = telemetryOf(ctx);
  const host = input.host ? normalizeTrafficHost(input.host) : undefined;
  const filter: RollupFilter = {
    orgId,
    edgeWhere: { ...(input.region ? { region: input.region } : {}), ...(input.nodeId ? { nodeId: input.nodeId } : {}) },
    hostWhere: { host: host ?? { not: '' }, ...(input.app !== undefined ? { app: input.app } : {}) },
    perHost: input.app !== undefined || host !== undefined,
  };

  const rows: TrafficSeriesRow[] = [];
  const coveredAt: number[] = [];
  // Hourly rows first (28d only), then 5-minute rows from the first hour not folded yet.
  let from = start;
  if (input.window === '28d') {
    const hourly = await readRollups(rollupTable(tdb, true), filter, start);
    rows.push(...hourly.rows);
    coveredAt.push(...hourly.coveredAt);
    if (hourly.coveredAt.length) from = Math.max(start, Math.max(...hourly.coveredAt) + TRAFFIC_HOUR_MS);
  }
  const fine = await readRollups(rollupTable(tdb, false), filter, from);
  rows.push(...fine.rows);
  coveredAt.push(...fine.coveredAt);

  // Ring tail: everything newer than the last flushed rollup.
  const lastFlushed = fine.coveredAt.length ? Math.max(...fine.coveredAt) + TRAFFIC_ROLLUP_MS : from;
  const tailFrom = Math.max(from, lastFlushed);
  const ring = ringOf(ctx);
  const appOf = trafficAppResolver(ctx);
  const inEdge = (nodeId: string) =>
    (!input.region || regionOf(ctx, nodeId) === input.region) && (!input.nodeId || nodeId === input.nodeId);
  for (const c of ring.cells(orgId, tailFrom, now)) {
    if (!inEdge(c.nodeId)) continue;
    if (input.app !== undefined && appOf(c.host) !== input.app) continue;
    if (host !== undefined && c.host !== host) continue;
    rows.push(c);
  }
  for (const [m, nodes] of ring.coverage(orgId, tailFrom, now)) {
    if ([...nodes.keys()].some(inEdge)) coveredAt.push(m);
  }

  const reports = [...ring.reports(orgId).values()];
  const series = bucketTrafficSeries({ rows, coveredAt, window: input.window, now });
  return {
    window: input.window,
    bucketSec: series.bucketSec,
    unit: 'requests/min',
    ...(input.app !== undefined ? { app: input.app } : {}),
    ...(input.region ? { region: input.region } : {}),
    ...(host ? { host } : {}),
    ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    sampledAt: reports.length ? Math.max(...reports.map((r) => r.lastAt)) : null,
    points: series.points,
  };
}
