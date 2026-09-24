import { buildInventory, STACK_LABEL, type MetricKind, type TimeseriesInput } from '@swarmy/core';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import type { DashboardSummary } from '@swarmy/core/views';
import { telemetryOf, type OrgContext } from '../context';

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

// ── Org scoping (pure, unit-tested) ─────────────────────────────────────────
//
// The hub's live inventory is RAW Docker truth: a manager's `docker node ls` /
// `docker service ls` lists every member of the physical swarm, which knows
// nothing about swarmy orgs. Dashboard stats must count only what THIS org
// owns: nodes = the org's enrollment rows (the same set the nodes table
// shows); services = everything except services whose stack is positively
// owned by ANOTHER org's Stack row (ungrouped / system / own stacks stay).

/** Node presence for the org: enrolled rows, online = agent connected. */
export function scopedNodeCounts(
  enrolledIds: string[],
  isOnline: (id: string) => boolean,
): { online: number; total: number } {
  return { online: enrolledIds.filter(isOnline).length, total: enrolledIds.length };
}

/**
 * Drop services whose stack namespace belongs to another org's Stack row and
 * not to this org's. `owners` maps stack name → orgIds that own a Stack with
 * that name.
 */
export function scopeServicesToOrg(
  services: SwarmServiceInfo[],
  orgId: string,
  owners: Map<string, Set<string>>,
): SwarmServiceInfo[] {
  return services.filter((s) => {
    const ns = s.labels?.[STACK_LABEL];
    if (!ns) return true;
    const o = owners.get(ns);
    return !o || o.has(orgId);
  });
}

/** Live services for the org's dashboard, minus other orgs' stacks. */
async function orgScopedServices(ctx: OrgContext): Promise<{
  services: SwarmServiceInfo[];
  containers: ReturnType<OrgContext['hub']['liveInventory']>['containers'];
}> {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const names = [...new Set(services.map((s) => s.labels?.[STACK_LABEL]).filter((n): n is string => !!n))];
  const owners = new Map<string, Set<string>>();
  if (names.length > 0) {
    const rows = (await ctx.db.stack.findMany({
      where: { name: { in: names } },
      select: { name: true, orgId: true },
    })) as Array<{ name: string; orgId: string }>;
    for (const r of rows) {
      const set = owners.get(r.name) ?? new Set<string>();
      set.add(r.orgId);
      owners.set(r.name, set);
    }
  }
  const scoped = scopeServicesToOrg(services, ctx.activeOrgId, owners);
  const keep = new Set(scoped.map((s) => s.id));
  return {
    services: scoped,
    containers: containers.filter((c) => {
      const sid = c.serviceId ?? c.labels?.['com.docker.swarm.service.id'];
      return !sid || keep.has(sid);
    }),
  };
}

export async function getOverview(ctx: OrgContext): Promise<ClusterOverview> {
  // Node presence (online/total) = the org's ENROLLED nodes (never the raw
  // swarm member list, which can include nodes enrolled to no/other orgs).
  const nodes = await ctx.db.node.findMany({
    where: { orgId: ctx.activeOrgId },
    select: { id: true },
  });
  const counts = scopedNodeCounts(
    nodes.map((n: { id: string }) => n.id),
    (id) => ctx.hub.isOnline(id),
  );
  let cpuSum = 0;
  let memUsed = 0;
  let memTotal = 0;
  let counted = 0;
  for (const n of nodes) {
    if (!ctx.hub.isOnline(n.id)) continue;
    const s = ctx.hub.latestNodeStats(n.id);
    if (s) {
      cpuSum += s.cpuPercent;
      memUsed += s.memUsedBytes;
      memTotal += s.memTotalBytes;
      counted += 1;
    }
  }
  const { services } = await orgScopedServices(ctx);
  const containersRunning = services.reduce((a, s) => a + s.runningReplicas, 0);
  return {
    cpuPercent: counted ? cpuSum / counted : 0,
    memPercent: memTotal ? (memUsed / memTotal) * 100 : 0,
    memUsedBytes: memUsed,
    memTotalBytes: memTotal,
    nodesOnline: counts.online,
    nodesTotal: counts.total,
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
  const rows = (await telemetryOf(ctx).metricSample.findMany({
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
  // Service totals come from live Docker inventory (no Service model). There is
  // no persisted deployment history any more, so the recent-deploy count is 0.
  const { services, containers } = await orgScopedServices(ctx);
  const inv = buildInventory(services, containers).services;
  const serviceTotal = inv.length;
  const serviceRunning = inv.filter((s) => s.status === 'running').length;
  const recentDeployments = 0;
  return {
    nodes: { online: overview.nodesOnline, total: overview.nodesTotal },
    services: { running: serviceRunning, total: serviceTotal },
    containersRunning: overview.containersRunning,
    recentDeployments,
    cpuPercent: overview.cpuPercent,
    memPercent: overview.memPercent,
  };
}
