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

/**
 * Node ROLES + region are Docker node labels (Docker is the source of truth — no
 * DB column). `swarmy.node.ingress`/`swarmy.node.outlet` flag a node as an
 * ingress edge / egress outlet; `swarmy.region` is its region. These are read
 * back live from the hub's swarm-node inventory (`nodeInfoFor(...).labels`).
 */
export const NODE_INGRESS_LABEL = 'swarmy.node.ingress';
export const NODE_OUTLET_LABEL = 'swarmy.node.outlet';
export const NODE_REGION_LABEL = 'swarmy.region';

/**
 * A node's position on the Infrastructure canvas is Docker-truth too — persisted
 * as `swarmy.canvas.x`/`swarmy.canvas.y` node labels (mirrors the service canvas),
 * never in swarmy's DB. Read back live from `nodeInfoFor(...).labels`.
 */
export const CANVAS_X_LABEL = 'swarmy.canvas.x';
export const CANVAS_Y_LABEL = 'swarmy.canvas.y';

/** Derive the role/region view from a node's live swarm labels. */
function rolesFromLabels(labels: Record<string, string> | undefined): {
  ingress: boolean;
  outlet: boolean;
  region: string | null;
} {
  return {
    ingress: labels?.[NODE_INGRESS_LABEL] === 'true',
    outlet: labels?.[NODE_OUTLET_LABEL] === 'true',
    region: labels?.[NODE_REGION_LABEL] ?? null,
  };
}

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
  const roles = rolesFromLabels(info?.labels);
  return {
    id: n.id,
    name: n.name,
    hostname: n.hostname,
    role: info?.role ?? 'worker',
    ingress: roles.ingress,
    outlet: roles.outlet,
    region: roles.region,
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

/**
 * Toggle a node's ROLES (ingress edge / egress outlet) via Docker node labels.
 * Only the roles present in `roles` are touched (partial update). Because
 * `updateSwarmNode` merges labels and cannot delete keys, "off" is written as the
 * empty string — any value other than `'true'` reads back as false. Best-effort
 * push (skipped while offline); Docker remains the source of truth.
 */
export async function setNodeRole(
  ctx: OrgContext,
  id: string,
  roles: { ingress?: boolean; outlet?: boolean },
): Promise<{ id: string; ingress: boolean; outlet: boolean }> {
  const node = await ctx.db.node.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    select: { id: true },
  });
  if (!node) throw notFound('node', id);

  const patch: Record<string, string> = {};
  if (roles.ingress !== undefined) patch[NODE_INGRESS_LABEL] = roles.ingress ? 'true' : '';
  if (roles.outlet !== undefined) patch[NODE_OUTLET_LABEL] = roles.outlet ? 'true' : '';

  const swarmNodeId = ctx.hub.swarmNodeIdFor(id);
  if (ctx.hub.isOnline(id) && swarmNodeId && Object.keys(patch).length > 0) {
    await ctx.hub.dispatch(id, 'node.update', { swarmNodeId, labels: patch }).catch(() => undefined);
  }

  // Reflect the resulting state: live labels merged with the patch we just sent.
  const merged = { ...(ctx.hub.nodeInfoFor(id)?.labels ?? {}), ...patch };
  const result = rolesFromLabels(merged);
  return { id, ingress: result.ingress, outlet: result.outlet };
}

/**
 * Read every enrolled node's saved canvas position from its live swarm labels
 * (`swarmy.canvas.x/y`). Nodes without a saved position are omitted — the canvas
 * auto-grids them. Mirrors the service canvas, but node labels aren't carried on
 * `NodeSummary`, so the canvas reads them through this dedicated map.
 */
export async function listNodeCanvasPositions(
  ctx: OrgContext,
): Promise<Record<string, { x: number; y: number }>> {
  const rows = (await ctx.db.node.findMany({
    where: { orgId: ctx.activeOrgId },
    select: { id: true },
  })) as { id: string }[];
  const out: Record<string, { x: number; y: number }> = {};
  for (const r of rows) {
    const labels = ctx.hub.nodeInfoFor(r.id)?.labels;
    const rx = labels?.[CANVAS_X_LABEL];
    const ry = labels?.[CANVAS_Y_LABEL];
    if (rx == null || ry == null) continue;
    const x = Number(rx);
    const y = Number(ry);
    if (Number.isFinite(x) && Number.isFinite(y)) out[r.id] = { x, y };
  }
  return out;
}

/**
 * Container count per enrolled node — the "what's running here" number the
 * Nodes index row shows without opening the node page. Sourced from the same
 * live hub snapshot the node detail's Containers panel reads
 * (`ctx.hub.latestContainers`); offline/never-seen nodes read back `0`.
 */
export async function listNodeContainerCounts(ctx: OrgContext): Promise<Record<string, number>> {
  const rows = (await ctx.db.node.findMany({
    where: { orgId: ctx.activeOrgId },
    select: { id: true },
  })) as { id: string }[];
  const out: Record<string, number> = {};
  for (const r of rows) {
    out[r.id] = ctx.hub.latestContainers(r.id).length;
  }
  return out;
}

/**
 * Persist a node's Infrastructure-canvas position as Docker node labels
 * (`swarmy.canvas.x/y`) — mirrors `service.setCanvasPosition`. Layout is
 * Docker-truth, not stored in swarmy's DB. Best-effort push (skipped while
 * offline; reconciles when the node reconnects).
 */
export async function setNodeCanvasPosition(
  ctx: OrgContext,
  input: { id: string; x: number; y: number },
): Promise<{ id: string; ok: true }> {
  const node = await ctx.db.node.findFirst({
    where: { id: input.id, orgId: ctx.activeOrgId },
    select: { id: true },
  });
  if (!node) throw notFound('node', input.id);

  const patch: Record<string, string> = {
    [CANVAS_X_LABEL]: String(Math.round(input.x)),
    [CANVAS_Y_LABEL]: String(Math.round(input.y)),
  };
  const swarmNodeId = ctx.hub.swarmNodeIdFor(input.id);
  if (ctx.hub.isOnline(input.id) && swarmNodeId) {
    await ctx.hub
      .dispatch(input.id, 'node.update', { swarmNodeId, labels: patch })
      .catch(() => undefined);
  }
  return { id: input.id, ok: true };
}

/**
 * Region is also a Docker node label (`swarmy.region`). The canonical impl
 * (audit + label merge via `node.update`) lives in geodns.service — reuse it so
 * the nodes router has a single import surface for node label mutations.
 */
export { setNodeRegion } from './geodns.service';

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
