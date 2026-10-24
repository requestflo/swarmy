import {
  TRAFFIC_ROLLUP_MS,
  TRAFFIC_WINDOWS,
  bucketTrafficSeries,
  decodeLatency,
  normalizeTrafficHost,
  type TrafficSeriesInput,
  type TrafficSeriesRow,
  type TrafficSeriesView,
} from '@swarmy/core';
import { telemetryOf, type OrgContext } from '../context';
import { regionOf, ringOf, trafficAppResolver } from './traffic.service';

/**
 * traffic.series — sparkline buckets. Persisted 5-minute rollups for the
 * span, topped up from the in-memory ring for the minutes not flushed yet
 * (and for everything after a controller restart until rollups catch up).
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
  const since = { orgId, bucketStart: { gte: new Date(start) } };
  const edgeWhere = { ...(input.region ? { region: input.region } : {}), ...(input.nodeId ? { nodeId: input.nodeId } : {}) };
  const hostWhere = { host: host ?? { not: '' }, ...(input.app !== undefined ? { app: input.app } : {}) };
  const perHost = input.app !== undefined || host !== undefined;

  const [dataRows, coverRows, latencyRows] = await Promise.all([
    tdb.edgeTrafficRollup
      .groupBy({
        by: ['bucketStart'],
        where: { ...since, ...edgeWhere, ...hostWhere },
        _sum: { requests: true, errors5xx: true, status403: true, status429: true },
      })
      .catch(() => []),
    tdb.edgeTrafficRollup.groupBy({ by: ['bucketStart'], where: { ...since, ...edgeWhere, host: '' } }).catch(() => []),
    tdb.edgeTrafficRollup
      .findMany({
        where: { ...since, ...edgeWhere, ...(perHost ? hostWhere : { host: '' }), durationBuckets: { not: null } },
        select: { bucketStart: true, durationBuckets: true },
      })
      .catch(() => []),
  ]);

  const rows: TrafficSeriesRow[] = dataRows.map((r) => ({
    t: r.bucketStart.getTime(),
    nodeId: '',
    host: '*',
    requests: r._sum.requests ?? 0,
    errors5xx: r._sum.errors5xx ?? 0,
    ...(r._sum.status403 !== null ? { status403: r._sum.status403 } : {}),
    ...(r._sum.status429 !== null ? { status429: r._sum.status429 } : {}),
  }));
  for (const r of latencyRows) {
    const latency = decodeLatency(r.durationBuckets);
    if (latency) rows.push({ t: r.bucketStart.getTime(), nodeId: '', host: '', requests: 0, errors5xx: 0, latency });
  }
  const coveredAt: number[] = coverRows.map((r) => r.bucketStart.getTime());

  // Ring tail: everything newer than the last flushed rollup.
  const lastFlushed = coveredAt.length ? Math.max(...coveredAt) + TRAFFIC_ROLLUP_MS : start;
  const tailFrom = Math.max(start, lastFlushed);
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
