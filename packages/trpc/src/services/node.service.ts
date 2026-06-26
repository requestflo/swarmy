import type { NodeDetail, NodeStatusView, NodeSummary } from '@swarmy/core/views';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { requireOnlineNode } from './dispatch.service';

type NodeRow = {
  id: string;
  name: string;
  hostname: string;
  ipAddress: string | null;
  role: string;
  status: string;
  swarmNodeId: string | null;
  dockerVersion: string | null;
  os: string | null;
  arch: string | null;
  totalCpu: number | null;
  totalMemoryBytes: bigint | null;
  labels: unknown;
  agentVersion: string | null;
  lastSeenAt: Date | null;
  createdAt: Date;
};

function statusOf(dbStatus: string, online: boolean): NodeStatusView {
  if (dbStatus === 'DRAINING') return 'draining';
  if (online) return 'online';
  if (dbStatus === 'PENDING') return 'pending';
  return 'offline';
}

function toSummary(ctx: OrgContext, n: NodeRow): NodeSummary {
  const online = ctx.hub.isOnline(n.id);
  const snap = ctx.hub.latestNodeStats(n.id);
  const live =
    snap && online
      ? {
          cpuPercent: snap.cpuPercent,
          memPercent: snap.memTotalBytes > 0 ? (snap.memUsedBytes / snap.memTotalBytes) * 100 : 0,
        }
      : null;
  return {
    id: n.id,
    name: n.name,
    hostname: n.hostname,
    role: n.role === 'MANAGER' ? 'manager' : 'worker',
    status: statusOf(n.status, online),
    engineVersion: n.dockerVersion,
    os: n.os,
    arch: n.arch,
    resources: { cpus: n.totalCpu, memBytes: n.totalMemoryBytes ? Number(n.totalMemoryBytes) : null },
    agentVersion: n.agentVersion,
    lastSeenAt: n.lastSeenAt ? n.lastSeenAt.toISOString() : null,
    live,
  };
}

export async function listNodes(ctx: OrgContext): Promise<NodeSummary[]> {
  const rows = await ctx.db.node.findMany({
    where: { orgId: ctx.activeOrgId },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => toSummary(ctx, r as NodeRow));
}

export async function getNode(ctx: OrgContext, id: string): Promise<NodeDetail> {
  const row = (await ctx.db.node.findFirst({
    where: { id, orgId: ctx.activeOrgId },
  })) as NodeRow | null;
  if (!row) throw notFound('node', id);
  return {
    ...toSummary(ctx, row),
    ipAddress: row.ipAddress,
    swarmNodeId: row.swarmNodeId,
    labels: (row.labels as Record<string, string>) ?? {},
    joinedAt: row.createdAt.toISOString(),
  };
}

export async function setNodeLabels(
  ctx: OrgContext,
  id: string,
  labels: Record<string, string>,
): Promise<{ id: string; labels: Record<string, string> }> {
  const node = (await ctx.db.node.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    select: { id: true, swarmNodeId: true },
  })) as { id: string; swarmNodeId: string | null } | null;
  if (!node) throw notFound('node', id);
  await ctx.db.node.update({ where: { id }, data: { labels } });
  // Best-effort push to the swarm node; ignore if offline (reconciles later).
  if (ctx.hub.isOnline(id) && node.swarmNodeId) {
    await ctx.hub
      .dispatch(id, 'node.update', { swarmNodeId: node.swarmNodeId, labels })
      .catch(() => undefined);
  }
  return { id, labels };
}

export async function setNodeAvailability(
  ctx: OrgContext,
  id: string,
  availability: 'active' | 'drain',
): Promise<{ id: string; availability: string }> {
  const node = await requireOnlineNode(ctx, id);
  const row = (await ctx.db.node.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    select: { swarmNodeId: true },
  })) as { swarmNodeId: string | null } | null;
  await ctx.hub.dispatch(node.id, 'node.update', {
    swarmNodeId: row?.swarmNodeId,
    availability: availability === 'drain' ? 'drain' : 'active',
  });
  await ctx.db.node.update({
    where: { id },
    data: { status: availability === 'drain' ? 'DRAINING' : 'ONLINE' },
  });
  return { id, availability };
}

export async function removeNode(ctx: OrgContext, id: string): Promise<{ id: string; removed: true }> {
  const node = await ctx.db.node.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    select: { id: true },
  });
  if (!node) throw notFound('node', id);
  await ctx.db.node.delete({ where: { id } });
  return { id, removed: true };
}
