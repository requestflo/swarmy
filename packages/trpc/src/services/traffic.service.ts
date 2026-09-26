import {
  EdgeTrafficRing,
  MINUTE_MS,
  TRAFFIC_ROLLUP_MS,
  TRAFFIC_ROLLUP_RETENTION_MS,
  TRAFFIC_WINDOWS,
  aggregateTrafficNow,
  bucketTrafficSeries,
  makeHostAppResolver,
  rollupRing,
  type TrafficEdgeInfo,
  type TrafficNowView,
  type TrafficSeriesInput,
  type TrafficSeriesRow,
  type TrafficSeriesView,
} from '@swarmy/core';
import type { TelemetryDB } from '@swarmy/db';
import { telemetryOf, type OrgContext } from '../context';
import { listRoutesForOrg } from './ingress-routes';
import { ingressTaskNodes } from './ingress-controller';

/**
 * Per-edge request counting (Q4) — the controller read/write layer.
 *
 * Live: the hub's in-memory 1-minute ring (last 6 h), fed by each edge
 * agent's `metrics.edge`. History: 5-minute `EdgeTrafficRollup` rows in
 * telemetry.db (7 days), flushed and pruned by the edge-traffic worker.
 * Region = the edge node's `swarmy.region` label; app = the stack whose
 * route owns the host (`swarmy.ingress.routes`, Docker truth). Hosts that
 * are no app's route land in the `app: null` "other" bucket — never dropped.
 */

const EMPTY_RING = new EdgeTrafficRing();

function ringOf(ctx: OrgContext): EdgeTrafficRing {
  return ctx.hub.edgeTraffic?.() ?? EMPTY_RING;
}

/** host → app (stack) from the org's live route labels. */
export function trafficAppResolver(ctx: OrgContext): (host: string) => string | null {
  return makeHostAppResolver(
    listRoutesForOrg(ctx).map((r) => ({ host: r.route.host, app: r.stack, path: r.route.path })),
  );
}

function regionOf(ctx: OrgContext, nodeId: string): string | null {
  return ctx.hub.nodeInfoFor(nodeId)?.labels?.['swarmy.region'] || null;
}

/**
 * Every edge worth listing: nodes running the edge Caddy task, nodes marked
 * `swarmy.node.ingress`, and any node that has reported traffic.
 */
async function trafficEdges(ctx: OrgContext, reported: Iterable<string>): Promise<TrafficEdgeInfo[]> {
  const ids = new Set<string>([
    ...(await ingressTaskNodes(ctx).catch(() => [] as string[])),
    ...ctx.hub.nodesByRole(ctx.activeOrgId, 'ingress'),
    ...reported,
  ]);
  const rows = await ctx.db.node.findMany({
    where: { orgId: ctx.activeOrgId, id: { in: [...ids] } },
    select: { id: true, name: true },
  });
  const names = new Map(rows.map((r) => [r.id, r.name] as const));
  return [...ids].map((nodeId) => ({
    nodeId,
    name: names.get(nodeId) ?? ctx.hub.nodeInfoFor(nodeId)?.hostname ?? nodeId,
    region: regionOf(ctx, nodeId),
  }));
}

/** traffic.now — per region, per app and totals over the last 5 complete minutes. */
export async function trafficNow(ctx: OrgContext, now = Date.now()): Promise<TrafficNowView> {
  const ring = ringOf(ctx);
  const orgId = ctx.activeOrgId;
  const from = now - 10 * MINUTE_MS;
  const reports = ring.reports(orgId);
  return aggregateTrafficNow({
    cells: ring.cells(orgId, from, now),
    coverage: ring.coverage(orgId, from, now),
    reports,
    edges: await trafficEdges(ctx, reports.keys()),
    appOf: trafficAppResolver(ctx),
    now,
  });
}

/**
 * traffic.series — sparkline buckets. Persisted 5-minute rollups for the
 * span, topped up from the in-memory ring for the minutes not flushed yet
 * (and for everything after a controller restart until rollups catch up).
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
  const regionWhere = input.region ? { region: input.region } : {};
  const appWhere = input.app !== undefined ? { app: input.app } : {};

  const [dataRows, coverRows] = await Promise.all([
    tdb.edgeTrafficRollup
      .groupBy({
        by: ['bucketStart'],
        where: { orgId, bucketStart: { gte: new Date(start) }, host: { not: '' }, ...regionWhere, ...appWhere },
        _sum: { requests: true, errors5xx: true },
      })
      .catch(() => []),
    tdb.edgeTrafficRollup
      .groupBy({
        by: ['bucketStart'],
        where: { orgId, bucketStart: { gte: new Date(start) }, host: '', ...regionWhere },
      })
      .catch(() => []),
  ]);

  const rows: TrafficSeriesRow[] = dataRows.map((r) => ({
    t: r.bucketStart.getTime(),
    nodeId: '',
    host: '*',
    requests: r._sum.requests ?? 0,
    errors5xx: r._sum.errors5xx ?? 0,
  }));
  const coveredAt: number[] = coverRows.map((r) => r.bucketStart.getTime());

  // Ring tail: everything newer than the last flushed rollup.
  const lastFlushed = coveredAt.length ? Math.max(...coveredAt) + TRAFFIC_ROLLUP_MS : start;
  const tailFrom = Math.max(start, lastFlushed);
  const ring = ringOf(ctx);
  const appOf = trafficAppResolver(ctx);
  const inRegion = (nodeId: string) => !input.region || regionOf(ctx, nodeId) === input.region;
  for (const c of ring.cells(orgId, tailFrom, now)) {
    if (!inRegion(c.nodeId)) continue;
    if (input.app !== undefined && appOf(c.host) !== input.app) continue;
    rows.push(c);
  }
  for (const [m, nodes] of ring.coverage(orgId, tailFrom, now)) {
    if ([...nodes.keys()].some(inRegion)) coveredAt.push(m);
  }

  const reports = [...ring.reports(orgId).values()];
  const series = bucketTrafficSeries({ rows, coveredAt, window: input.window, now });
  return {
    window: input.window,
    bucketSec: series.bucketSec,
    unit: 'requests/min',
    ...(input.app !== undefined ? { app: input.app } : {}),
    ...(input.region ? { region: input.region } : {}),
    sampledAt: reports.length ? Math.max(...reports.map((r) => r.lastAt)) : null,
    points: series.points,
  };
}

/**
 * Persist the ring's `[from, to)` as 5-minute rollups (worker). Region and
 * app are resolved now, from the live labels/routes. Idempotent per
 * (org, node, host, bucket). Returns the number of rows written.
 */
export async function flushTrafficRollups(
  ctx: OrgContext,
  ring: EdgeTrafficRing,
  window: { from: number; to: number },
): Promise<number> {
  const rows = rollupRing(ring, ctx.activeOrgId, window.from, window.to);
  if (rows.length === 0) return 0;
  const appOf = trafficAppResolver(ctx);
  const tdb = telemetryOf(ctx);
  await tdb.$transaction(
    rows.map((r) => {
      const data = {
        region: regionOf(ctx, r.nodeId),
        app: r.host === '' ? null : appOf(r.host),
        requests: r.requests,
        errors5xx: r.errors5xx,
      };
      const bucketStart = new Date(r.bucketStart);
      return tdb.edgeTrafficRollup.upsert({
        where: {
          orgId_nodeId_host_bucketStart: { orgId: ctx.activeOrgId, nodeId: r.nodeId, host: r.host, bucketStart },
        },
        create: { orgId: ctx.activeOrgId, nodeId: r.nodeId, host: r.host, bucketStart, ...data },
        update: data,
      });
    }),
  );
  return rows.length;
}

/** Drop rollups older than 7 days (all orgs). */
export async function pruneTrafficRollups(tdb: TelemetryDB, now = Date.now()): Promise<number> {
  const res = await tdb.edgeTrafficRollup.deleteMany({
    where: { bucketStart: { lt: new Date(now - TRAFFIC_ROLLUP_RETENTION_MS) } },
  });
  return res.count;
}
