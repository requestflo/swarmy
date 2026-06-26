import type { MetricKind, TimeseriesInput } from '@swarmy/core';
import type { DashboardSummary } from '@swarmy/core/views';
import type { OrgContext } from '../context';

export interface ClusterOverview {
  cpuPercent: number;
  memPercent: number;
  memUsedBytes: number;
  memTotalBytes: number;
  nodesOnline: number;
  nodesTotal: number;
  containersRunning: number;
  sampledAt: string;
}

const RANGE_MS: Record<string, number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
};

export async function getOverview(ctx: OrgContext): Promise<ClusterOverview> {
  const nodes = await ctx.db.node.findMany({
    where: { orgId: ctx.activeOrgId },
    select: { id: true },
  });
  const online = nodes.filter((n) => ctx.hub.isOnline(n.id));
  let cpuSum = 0;
  let memUsed = 0;
  let memTotal = 0;
  let counted = 0;
  for (const n of online) {
    const s = ctx.hub.latestNodeStats(n.id);
    if (s) {
      cpuSum += s.cpuPercent;
      memUsed += s.memUsedBytes;
      memTotal += s.memTotalBytes;
      counted += 1;
    }
  }
  const containersRunning = ctx.hub
    .latestServiceState(ctx.activeOrgId)
    .reduce((a, s) => a + s.runningReplicas, 0);
  return {
    cpuPercent: counted ? cpuSum / counted : 0,
    memPercent: memTotal ? (memUsed / memTotal) * 100 : 0,
    memUsedBytes: memUsed,
    memTotalBytes: memTotal,
    nodesOnline: online.length,
    nodesTotal: nodes.length,
    containersRunning,
    sampledAt: new Date().toISOString(),
  };
}

interface SampleRow {
  ts: Date;
  cpuPercent: number;
  memUsedBytes: bigint;
  memTotalBytes: bigint;
  netRxBytes: bigint;
  netTxBytes: bigint;
  diskUsedBytes: bigint;
  diskTotalBytes: bigint;
}

function valueFor(metric: MetricKind, r: SampleRow): number {
  switch (metric) {
    case 'cpu':
      return r.cpuPercent;
    case 'mem':
      return r.memTotalBytes > 0n ? (Number(r.memUsedBytes) / Number(r.memTotalBytes)) * 100 : 0;
    case 'net':
      return Number(r.netRxBytes + r.netTxBytes);
    case 'disk':
      return Number(r.diskUsedBytes);
    default:
      return 0;
  }
}

export async function getTimeseries(
  ctx: OrgContext,
  input: TimeseriesInput,
): Promise<{ metric: MetricKind; points: { t: string; v: number }[] }> {
  const since = new Date(Date.now() - (RANGE_MS[input.range] ?? RANGE_MS['1h']!));
  const rows = (await ctx.db.metricSample.findMany({
    where: {
      orgId: ctx.activeOrgId,
      ts: { gte: since },
      nodeId: input.nodeId,
      containerId: input.containerId,
      scope: input.containerId ? 'CONTAINER' : 'NODE',
    },
    orderBy: { ts: 'asc' },
    take: 2000,
  })) as unknown as SampleRow[];
  return { metric: input.metric, points: rows.map((r) => ({ t: r.ts.toISOString(), v: valueFor(input.metric, r) })) };
}

export interface TopConsumer {
  id: string;
  name: string;
  kind: 'node' | 'service';
  value: number;
  unit: string;
}

export async function getTopConsumers(
  ctx: OrgContext,
  input: { metric: MetricKind; limit: number },
): Promise<TopConsumer[]> {
  const nodes = await ctx.db.node.findMany({
    where: { orgId: ctx.activeOrgId },
    select: { id: true, name: true },
  });
  const rows = nodes
    .map((n) => {
      const s = ctx.hub.latestNodeStats(n.id);
      const value = s
        ? input.metric === 'cpu'
          ? s.cpuPercent
          : input.metric === 'mem'
            ? s.memTotalBytes
              ? (s.memUsedBytes / s.memTotalBytes) * 100
              : 0
            : s.netRxBytes + s.netTxBytes
        : 0;
      return { id: n.id, name: n.name, kind: 'node' as const, value, unit: input.metric === 'net' ? 'B/s' : '%' };
    })
    .sort((a, b) => b.value - a.value)
    .slice(0, input.limit);
  return rows;
}

export async function getDashboardSummary(ctx: OrgContext): Promise<DashboardSummary> {
  const overview = await getOverview(ctx);
  const [serviceTotal, serviceRunning, recentDeployments] = await Promise.all([
    ctx.db.service.count({ where: { orgId: ctx.activeOrgId } }),
    ctx.db.service.count({ where: { orgId: ctx.activeOrgId, status: 'RUNNING' } }),
    ctx.db.deployment.count({
      where: { orgId: ctx.activeOrgId, startedAt: { gte: new Date(Date.now() - 24 * 60 * 60_000) } },
    }),
  ]);
  return {
    nodes: { online: overview.nodesOnline, total: overview.nodesTotal },
    services: { running: serviceRunning, total: serviceTotal },
    containersRunning: overview.containersRunning,
    recentDeployments,
    cpuPercent: overview.cpuPercent,
    memPercent: overview.memPercent,
  };
}
