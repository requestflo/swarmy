import type { SwarmNodeInfo } from '@swarmy/core/protocol';
import type { NodeDetail, NodeStatusView, NodeSummary } from '@swarmy/core/views';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { requireOnlineNode } from './dispatch.service';

/**
 * Node is now an enrollment/auth record (identity only): `{ id, orgId, name,
 * hostname, … }`. Every swarm/telemetry field (role, status, labels, engine/os/
 * arch, cpus/mem, lastSeen) is Docker truth, read live from the hub and merged
 * on read — never persisted on the Node row. Membership/identity reads still hit
 * `ctx.db.node`; swarm-field reads come from `ctx.hub.nodeInfoFor`/`lastSeen`/
 * `isOnline`/`swarmNodeIdFor`.
 */
type NodeRow = {
  id: string;
  name: string;
  hostname: string;
  createdAt: Date;
};

/** Dashboard status from live swarm availability + connection state. */
function statusOf(info: SwarmNodeInfo | undefined, online: boolean, everSeen: boolean): NodeStatusView {
  if (info?.availability === 'drain') return 'draining';
  if (online) return 'online';
  // Never connected (no heartbeat, no swarm info) = still pending enrollment.
  if (!everSeen && !info) return 'pending';
  return 'offline';
}

function toSummary(ctx: OrgContext, n: NodeRow): NodeSummary {
  const online = ctx.hub.isOnline(n.id);
  const info = ctx.hub.nodeInfoFor(n.id);
  const lastSeen = ctx.hub.lastSeen(n.id);
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
    role: info?.role ?? 'worker',
    status: statusOf(info, online, lastSeen != null),
    engineVersion: info?.engineVersion ?? null,
    os: info?.os ?? null,
    arch: info?.arch ?? null,
    resources: { cpus: info?.cpus ?? null, memBytes: info?.memBytes ?? null },
    // No Docker-truth source for the swarmy *agent* version (only the engine version).
    agentVersion: null,
    lastSeenAt: lastSeen != null ? new Date(lastSeen).toISOString() : null,
    live,
  };
}

export async function listNodes(ctx: OrgContext): Promise<NodeSummary[]> {
  // Enrollment rows are the canonical node set (identity); swarm fields merge on
  // read. Offline-but-enrolled nodes still appear — `nodeInfoFor` folds in their
  // last-known swarm info (the same source as `nodeInventory(includeOffline)`).
  const rows = (await ctx.db.node.findMany({
    where: { orgId: ctx.activeOrgId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true, hostname: true, createdAt: true },
  })) as NodeRow[];
  return rows.map((r) => toSummary(ctx, r));
}

export async function getNode(ctx: OrgContext, id: string): Promise<NodeDetail> {
  const row = (await ctx.db.node.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    select: { id: true, name: true, hostname: true, createdAt: true },
  })) as NodeRow | null;
  if (!row) throw notFound('node', id);
  const info = ctx.hub.nodeInfoFor(id);
  return {
    ...toSummary(ctx, row),
    ipAddress: info?.addr ?? null,
    swarmNodeId: info?.swarmNodeId ?? ctx.hub.swarmNodeIdFor(id) ?? null,
    labels: info?.labels ?? {},
    joinedAt: row.createdAt.toISOString(),
  };
}

export async function setNodeLabels(
  ctx: OrgContext,
  id: string,
  labels: Record<string, string>,
): Promise<{ id: string; labels: Record<string, string> }> {
  const node = await ctx.db.node.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    select: { id: true },
  });
  if (!node) throw notFound('node', id);
  // Apply to the swarm node (Docker truth); labels read back via `nodeInfoFor`.
  // We do NOT persist labels on the Node row. Best-effort push — ignore if
  // offline (reconciles when the node reconnects).
  const swarmNodeId = ctx.hub.swarmNodeIdFor(id);
  if (ctx.hub.isOnline(id) && swarmNodeId) {
    await ctx.hub.dispatch(id, 'node.update', { swarmNodeId, labels }).catch(() => undefined);
  }
  return { id, labels };
}

export async function setNodeAvailability(
  ctx: OrgContext,
  id: string,
  availability: 'active' | 'drain',
): Promise<{ id: string; availability: string }> {
  const node = await requireOnlineNode(ctx, id);
  const swarmNodeId = ctx.hub.swarmNodeIdFor(id);
  await ctx.hub.dispatch(node.id, 'node.update', {
    swarmNodeId,
    availability: availability === 'drain' ? 'drain' : 'active',
  });
  // No DB telemetry write — drain state is Docker truth (reads back via nodeInfoFor).
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
