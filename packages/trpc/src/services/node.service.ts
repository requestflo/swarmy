import {
  NODE_BUILDER_LABEL,
  NODE_DATABASE_LABEL,
  NODE_EXEC_LABEL,
  NODE_SHELL_LABEL,
  NODE_DISK_FORMAT_LABEL,
  hasExecDisabledLabel,
  hasShellLabel,
  NODE_STORAGE_LABEL,
  LEGACY_BUILDER_ROLE_LABEL,
  hasBuilderLabel,
  profileToLabels,
  type NodeProfile,
  isPublicIpv4,
  observedPublicIpv4,
} from '@swarmy/core';
import type { SwarmNodeInfo, SwarmState } from '@swarmy/core/protocol';
import type { NodeDetail, NodeStatusView, NodeSummary } from '@swarmy/core/views';
import type { OrgContext } from '../context';
import type { AgentHub } from '../hub/types';
import { commandRejected, notFound } from '../errors';
import { TRPCError } from '@trpc/server';
import { writeAudit } from './audit.service';
import { agentRelease, platformForArch } from './agent-release.service';
import { requireOnlineNode } from './dispatch.service';
import { FOREIGN_SWARM_DETAIL, FOREIGN_SWARM_FIX, foreignSwarmDetail, swarmOrchestrationStatus } from './swarm.service';

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
 * Public IP for the geo-edge DNS layer (Docker-truth, like roles/region).
 * `swarmy.node.public-ip` is stamped by the controller from the agent's
 * self-report (cross-checked against the websocket source address);
 * `swarmy.node.public-ip.override` is operator-set and ALWAYS wins — the
 * escape hatch for NAT/proxy topologies where detection is wrong.
 */
export const NODE_PUBLIC_IP_LABEL = 'swarmy.node.public-ip';
export const NODE_PUBLIC_IP_OVERRIDE_LABEL = 'swarmy.node.public-ip.override';

/**
 * Is the node reachable from outside (`public`) or behind NAT (`nat`, a home
 * VM)? Stamped from the agent's heartbeat; the operator-set override wins.
 * The retire planner never puts a NAT'd node in a manager/Garage/edge role
 * (QA-084, node-decommission.plan.ts `nodeReachability`).
 */
export const NODE_REACHABILITY_LABEL = 'swarmy.node.reachability';
export const NODE_REACHABILITY_OVERRIDE_LABEL = 'swarmy.node.reachability.override';

/** Effective public IP from live labels (override beats agent-reported). */
export function publicIpFromLabels(labels: Record<string, string> | undefined): string | null {
  return labels?.[NODE_PUBLIC_IP_OVERRIDE_LABEL] || labels?.[NODE_PUBLIC_IP_LABEL] || null;
}

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
  storage: boolean;
  database: boolean;
  builder: boolean;
  exec: boolean;
  shell: boolean;
  region: string | null;
} {
  return {
    ingress: labels?.[NODE_INGRESS_LABEL] === 'true',
    outlet: labels?.[NODE_OUTLET_LABEL] === 'true',
    storage: labels?.[NODE_STORAGE_LABEL] === 'true',
    database: labels?.[NODE_DATABASE_LABEL] === 'true',
    builder: hasBuilderLabel(labels),
    exec: !hasExecDisabledLabel(labels),
    shell: hasShellLabel(labels),
    region: labels?.[NODE_REGION_LABEL] ?? null,
  };
}

/** Dashboard status from live swarm availability + connection state. Exported for tests. */
export function statusOf(
  info: SwarmNodeInfo | undefined,
  online: boolean,
  everSeen: boolean,
  swarmState: SwarmState | undefined,
): NodeStatusView {
  if (info?.availability === 'drain') return 'draining';
  // Agent connected but the node isn't a working swarm member (e.g. `docker
  // swarm leave` was run): it can't run workloads, so it's degraded — never
  // "online". `undefined` = a legacy agent that predates swarmState → trust the
  // connection. `pending` (mid-join) is a transient degraded state too.
  if (online && swarmState !== undefined && swarmState !== 'active') return 'degraded';
  if (online) return 'online';
  // Never connected (no heartbeat, no swarm info) = still pending enrollment.
  if (!everSeen && !info) return 'pending';
  return 'offline';
}

/**
 * Is this node stuck in someone else's swarm (QA-065)? Live hub truth; `self`
 * overrides the node's own membership (at register, before its first
 * serviceState, the gateway knows it only from the register facts).
 */
export function foreignSwarmOf(
  hub: Pick<AgentHub, 'managerNodes' | 'nodeInfoFor' | 'swarmStateFor' | 'isOnline'>,
  orgId: string,
  nodeId: string,
  self?: { inSwarm: boolean; isManager: boolean },
): string | null {
  const managers = hub.managerNodes(orgId);
  const state = hub.swarmStateFor(nodeId);
  return foreignSwarmDetail({
    inSwarm: self?.inSwarm ?? (hub.isOnline(nodeId) && (state === 'active' || state === 'pending' || state === 'error')),
    isManager: self?.isManager ?? managers.includes(nodeId),
    otherLiveManagers: managers.filter((m) => m !== nodeId).length,
    listedByOrgSwarm: hub.nodeInfoFor(nodeId) !== undefined,
  });
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
    storage: roles.storage,
    database: roles.database,
    builder: roles.builder,
    buildOverride: ctx.hub.agentBuildFor?.(n.id)?.buildOverride ?? null,
    exec: roles.exec,
    execOverride: ctx.hub.agentBuildFor?.(n.id)?.execOverride ?? null,
    shell: roles.shell,
    shellOverride: ctx.hub.agentBuildFor?.(n.id)?.shellOverride ?? null,
    region: roles.region,
    publicIp: publicIpFromLabels(info?.labels),
    // In a swarm, but not this org's: it can never run anything — never "online" (QA-065).
    status: foreignSwarmOf(ctx.hub, ctx.activeOrgId, n.id)
      ? 'degraded'
      : statusOf(info, online, lastSeen != null, ctx.hub.swarmStateFor(n.id)),
    engineVersion: info?.engineVersion ?? null,
    os: info?.os ?? null,
    arch: info?.arch ?? null,
    resources: { cpus: info?.cpus ?? null, memBytes: info?.memBytes ?? null },
    // From the agent's register facts (kept in the hub, not the DB).
    agentVersion: ctx.hub.agentBuildFor?.(n.id)?.version ?? null,
    agentCommit: ctx.hub.agentBuildFor?.(n.id)?.commit ?? null,
    agentUpdateAvailable: agentUpdateAvailable(ctx.hub.agentBuildFor?.(n.id)),
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

/** The stored orchestration outcome, with the foreign-swarm verdict taken live (it clears once fixed). */
function orchestrationView(ctx: OrgContext, id: string): NodeDetail['swarmOrchestration'] {
  const foreign = foreignSwarmOf(ctx.hub, ctx.activeOrgId, id);
  const stored = swarmOrchestrationStatus(id);
  if (foreign) {
    return stored?.detail === foreign ? stored : { state: 'failed', detail: foreign, fix: FOREIGN_SWARM_FIX, at: new Date().toISOString() };
  }
  return stored?.detail === FOREIGN_SWARM_DETAIL ? null : stored;
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
    // Why this node is (or isn't) in the swarm — waiting/joined/re-elected/failed.
    swarmOrchestration: orchestrationView(ctx, id),
  };
}

/**
 * Best-effort swarm node-label write. `docker node update` is MANAGER-only, so
 * the dispatch must go to a manager agent, not the target node — dispatching to
 * the node itself silently fails the moment the org has real worker nodes
 * (single-node dev swarms masked this). Falls back to the target node when no
 * manager is known (it may itself be the manager mid-bootstrap).
 */
export async function dispatchNodeLabels(
  hub: AgentHub,
  orgId: string,
  targetNodeId: string,
  labels: Record<string, string>,
): Promise<boolean> {
  const swarmNodeId = hub.swarmNodeIdFor(targetNodeId);
  if (!swarmNodeId) return false;
  const via = hub.managerNode(orgId) ?? (hub.isOnline(targetNodeId) ? targetNodeId : undefined);
  if (!via) return false;
  return await hub
    .dispatch(via, 'node.update', { swarmNodeId, labels })
    .then(() => true)
    .catch(() => false);
}

/**
 * Capability labels that must only change through the admin-only, audited
 * `nodes.setRole` toggles — never the generic (member-reachable) label editor,
 * or any member could hand themselves a host shell.
 */
export const RESERVED_CAPABILITY_LABELS: readonly string[] = [NODE_EXEC_LABEL, NODE_SHELL_LABEL, NODE_DISK_FORMAT_LABEL];

export async function setNodeLabels(
  ctx: OrgContext,
  id: string,
  labels: Record<string, string>,
): Promise<{ id: string; labels: Record<string, string> }> {
  const reserved = Object.keys(labels).filter((k) => RESERVED_CAPABILITY_LABELS.includes(k));
  if (reserved.length > 0) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `${reserved.join(', ')} can only be changed from the node's Controls toggles (admin only)`,
    });
  }
  const node = await ctx.db.node.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    select: { id: true },
  });
  if (!node) throw notFound('node', id);
  // Apply to the swarm node (Docker truth); labels read back via `nodeInfoFor`.
  // We do NOT persist labels on the Node row. Best-effort push — ignore if
  // offline (reconciles when the node reconnects).
  await dispatchNodeLabels(ctx.hub, ctx.activeOrgId, id, labels);
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
  roles: {
    ingress?: boolean;
    outlet?: boolean;
    storage?: boolean;
    database?: boolean;
    builder?: boolean;
    /** Container exec (`swarmy.node.exec`) — default on; `false` disables exec on this node. */
    exec?: boolean;
    /** Host shell (`swarmy.node.shell`) — default off; root on the host. Audited. */
    shell?: boolean;
  },
): Promise<{
  id: string;
  ingress: boolean;
  outlet: boolean;
  storage: boolean;
  database: boolean;
  builder: boolean;
  exec: boolean;
  shell: boolean;
}> {
  const node = await ctx.db.node.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    select: { id: true },
  });
  if (!node) throw notFound('node', id);

  const patch: Record<string, string> = {};
  if (roles.ingress !== undefined) patch[NODE_INGRESS_LABEL] = roles.ingress ? 'true' : '';
  if (roles.outlet !== undefined) patch[NODE_OUTLET_LABEL] = roles.outlet ? 'true' : '';
  if (roles.storage !== undefined) patch[NODE_STORAGE_LABEL] = roles.storage ? 'true' : '';
  if (roles.database !== undefined) patch[NODE_DATABASE_LABEL] = roles.database ? 'true' : '';
  if (roles.builder !== undefined) {
    patch[NODE_BUILDER_LABEL] = roles.builder ? 'true' : '';
    // Turning the role OFF must also clear the legacy `swarmy.role=builder`
    // spelling, or hasBuilderLabel would keep reporting it on.
    if (!roles.builder && ctx.hub.nodeInfoFor(id)?.labels[LEGACY_BUILDER_ROLE_LABEL] === 'builder') {
      patch[LEGACY_BUILDER_ROLE_LABEL] = '';
    }
  }

  // Terminal capabilities. Exec is default-on, so "on" writes 'true' and "off"
  // writes 'false' (absent also reads as on). Shell is default-off: 'true' / ''.
  if (roles.exec !== undefined) patch[NODE_EXEC_LABEL] = roles.exec ? 'true' : 'false';
  if (roles.shell !== undefined) patch[NODE_SHELL_LABEL] = roles.shell ? 'true' : '';

  if (Object.keys(patch).length > 0) {
    await dispatchNodeLabels(ctx.hub, ctx.activeOrgId, id, patch);
  }

  // Terminal capability flips are security events — record each one. (A host
  // shell grants root on the node; container exec is a shell in every workload.)
  if (roles.exec !== undefined) {
    await writeAudit(ctx, {
      action: roles.exec ? 'node.exec.enable' : 'node.exec.disable',
      targetType: 'node',
      targetId: id,
      metadata: { label: NODE_EXEC_LABEL, value: patch[NODE_EXEC_LABEL] },
    });
  }
  if (roles.shell !== undefined) {
    await writeAudit(ctx, {
      action: roles.shell ? 'node.shell.enable' : 'node.shell.disable',
      targetType: 'node',
      targetId: id,
      metadata: { label: NODE_SHELL_LABEL, value: patch[NODE_SHELL_LABEL] },
    });
  }

  // Reflect the resulting state: live labels merged with the patch we just sent.
  const merged = { ...(ctx.hub.nodeInfoFor(id)?.labels ?? {}), ...patch };
  const result = rolesFromLabels(merged);
  return {
    id,
    ingress: result.ingress,
    outlet: result.outlet,
    storage: result.storage,
    database: result.database,
    builder: result.builder,
    exec: result.exec,
    shell: result.shell,
  };
}

/**
 * Operator override for a node's public IP (`swarmy.node.public-ip.override`,
 * beats the agent-reported label everywhere). `null` clears the override
 * (written as '' — swarm label merge cannot delete keys).
 */
export async function setPublicIpOverride(
  ctx: OrgContext,
  id: string,
  ip: string | null,
): Promise<{ id: string; publicIp: string | null }> {
  const node = await ctx.db.node.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    select: { id: true },
  });
  if (!node) throw notFound('node', id);

  const patch = { [NODE_PUBLIC_IP_OVERRIDE_LABEL]: ip ?? '' };
  await dispatchNodeLabels(ctx.hub, ctx.activeOrgId, id, patch);
  const merged = { ...(ctx.hub.nodeInfoFor(id)?.labels ?? {}), ...patch };
  return { id, publicIp: publicIpFromLabels(merged) };
}

/**
 * Stamp the agent-reported public IP onto the node's Docker labels
 * (`swarmy.node.public-ip`). Called by the gateway on register/heartbeat with
 * the websocket source address for cross-checking — on disagreement we prefer
 * the self-report (NAT hairpins make the socket address wrong more often than
 * an outbound check) but log it. No-ops when unchanged, so heartbeat-frequency
 * calls cost one label lookup.
 */
/**
 * Apply a join token's install-profile label bundle to a freshly-enrolled node
 * (roadmap WS7). Enrollment races the swarm join — the node has no swarm labels
 * to patch until `swarm.join` completes — so this retries with a fixed cadence
 * for a couple of minutes, then gives up quietly (the profile is a starting
 * point; the role switches always work). Fire-and-forget from the register path.
 */
export async function stampProfileLabels(
  hub: AgentHub,
  orgId: string,
  nodeId: string,
  profile: NodeProfile,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<boolean> {
  const ok = await stampNodeLabelsWhenJoined(hub, orgId, nodeId, profileToLabels(profile), opts);
  if (!ok) console.warn(`[profiles] node ${nodeId}: could not stamp '${profile}' labels (node never joined the swarm?)`);
  return ok;
}

/**
 * Stamp a label patch once the node has swarm identity (enrollment races the
 * swarm join). Retries on a fixed cadence, then gives up quietly (false).
 */
async function stampNodeLabelsWhenJoined(
  hub: AgentHub,
  orgId: string,
  nodeId: string,
  patch: Record<string, string>,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<boolean> {
  if (Object.keys(patch).length === 0) return true;
  const attempts = opts.attempts ?? 24;
  const delayMs = opts.delayMs ?? 5_000;
  for (let i = 0; i < attempts; i++) {
    const existing = hub.nodeInfoFor(nodeId)?.labels;
    if (existing && Object.entries(patch).every(([k, v]) => existing[k] === v)) return true;
    if (existing) {
      const stamped = await dispatchNodeLabels(hub, orgId, nodeId, patch).catch(() => false);
      if (stamped) return true;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

/**
 * CI/CD default: an org whose FIRST (and only) node just enrolled gets the
 * Builder role on that node, so "link a repo → Build" works out of the box on a
 * single-box install. Multi-node orgs pick builders explicitly via the role
 * switch. Called fire-and-forget from the register path for brand-new nodes
 * only (never on re-adoption/repair, so an operator's "off" sticks).
 */
export async function stampDefaultBuilderRole(
  deps: { db: { node: { count(args: { where: { orgId: string } }): Promise<number> } }; hub: AgentHub },
  orgId: string,
  nodeId: string,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<boolean> {
  const count = await deps.db.node.count({ where: { orgId } });
  if (count !== 1) return false;
  const ok = await stampNodeLabelsWhenJoined(deps.hub, orgId, nodeId, { [NODE_BUILDER_LABEL]: 'true' }, opts);
  if (!ok) console.warn(`[cicd] node ${nodeId}: could not default the Builder role (node never joined the swarm?)`);
  return ok;
}

/**
 * PURE — which IP to stamp as `swarmy.node.public-ip` (plans/self-reliance.md
 * B8). The agent's report wins when present (current agents report the
 * controller-observed address from registerAck, and only fall back to echo
 * services when that was private); otherwise the WSS source address, when it
 * is public. The manual override label is read ahead of this label by
 * {@link publicIpFromLabels}, so it always wins.
 */
export function publicIpToStamp(reportedIp: string | undefined, socketAddr: string | undefined): string | undefined {
  if (reportedIp && isPublicIpv4(reportedIp)) return reportedIp.trim();
  return observedPublicIpv4(socketAddr);
}

export async function stampReportedPublicIp(
  hub: AgentHub,
  orgId: string,
  nodeId: string,
  reportedIp: string | undefined,
  socketAddr?: string,
  reachability?: 'public' | 'nat',
): Promise<void> {
  const ip = publicIpToStamp(reportedIp, socketAddr);
  const labels = hub.nodeInfoFor(nodeId)?.labels;
  // One label write for both (concurrent node updates race on the version).
  const patch: Record<string, string> = {};
  if (ip && labels?.[NODE_PUBLIC_IP_LABEL] !== ip) patch[NODE_PUBLIC_IP_LABEL] = ip;
  if (reachability && labels?.[NODE_REACHABILITY_LABEL] !== reachability) patch[NODE_REACHABILITY_LABEL] = reachability;
  if (Object.keys(patch).length === 0) return;
  // Pre-swarm nodes have no node labels to stamp yet — stay silent, the next
  // heartbeat after the swarm join lands it (warning here would fire per beat).
  const stamped = await dispatchNodeLabels(hub, orgId, nodeId, patch);
  if (!stamped || !patch[NODE_PUBLIC_IP_LABEL]) return;
  const source = observedPublicIpv4(socketAddr);
  if (reportedIp && source && source !== reportedIp) {
    console.warn(
      `[geo-edge] node ${nodeId}: self-reported public ip ${reportedIp} != socket source ${source} (using self-report; set the override label if wrong)`,
    );
  }
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
  const node = await ctx.db.node.findFirst({ where: { id, orgId: ctx.activeOrgId }, select: { id: true } });
  if (!node) throw notFound('node', id);
  const swarmNodeId = ctx.hub.swarmNodeIdFor(id);
  if (!swarmNodeId) throw commandRejected('the server has no swarm id yet');
  // `docker node update` is MANAGER-only: dispatch to a manager, never the
  // target (a worker answers "This node is not a swarm manager"). The target
  // may be offline — draining a dead server is exactly how you retire it.
  const via = ctx.hub.managerNode(ctx.activeOrgId) ?? (ctx.hub.isOnline(id) ? id : undefined);
  if (!via) throw commandRejected('no manager is online to change the server’s availability');
  await ctx.hub.dispatch(via, 'node.update', {
    swarmNodeId,
    availability: availability === 'drain' ? 'drain' : 'active',
  });
  // No DB telemetry write — drain state is Docker truth (reads back via nodeInfoFor).
  return { id, availability };
}

function agentUpdateAvailable(build: { version: string; commit?: string } | undefined): boolean {
  const release = agentRelease();
  return Boolean(build && release && !isSameAgentBuild(build, release));
}

/**
 * Is the node already running this controller's agent build? Same version AND,
 * when the release knows its commit, the same commit — every unreleased build
 * is version 0.0.0, so comparing versions alone made "Upgrade agent" a silent
 * no-op (found on the launch test). An agent that doesn't report a commit
 * predates the field, so it is by definition older. Pure.
 */
export function isSameAgentBuild(
  build: { version: string; commit?: string },
  release: { version: string; commit?: string },
): boolean {
  if (build.version !== release.version) return false;
  if (!release.commit) return true;
  return build.commit === release.commit;
}

/**
 * Push this controller's agent release to a node. Strategy follows the node's
 * reported packaging: compiled host binary → `self-replace` (download from
 * this controller, sha256-pinned); container backend → `docker-recreate`
 * (pull the matching image, recreate the agent container). The command
 * resolves when the agent has swapped and is about to restart; the reconnect
 * with the new `agentVersion` in its register facts is the confirmation.
 */
export async function upgradeAgent(
  ctx: OrgContext,
  id: string,
  /** Platform upgrades pin the container agent to the release manifest's digest. */
  opts: { image?: string } = {},
): Promise<{ id: string; targetVersion: string; strategy: string } | { id: string; upToDate: true }> {
  const release = agentRelease();
  if (!release) {
    throw new Error('no agent release available on this controller (binaries not built)');
  }
  const node = await requireOnlineNode(ctx, id);
  const build = ctx.hub.agentBuildFor?.(id);
  if (build && isSameAgentBuild(build, release)) return { id, upToDate: true };

  const controllerUrl =
    process.env.CONTROLLER_PUBLIC_URL ?? process.env.BETTER_AUTH_URL ?? 'http://localhost:3021';

  if (build?.packaging === 'binary') {
    const platform = platformForArch(ctx.hub.nodeInfoFor(id)?.arch);
    const pinned = platform ? release.platforms[platform] : undefined;
    if (!platform || !pinned) {
      throw new Error(`no released binary for this node's platform (arch: ${ctx.hub.nodeInfoFor(id)?.arch ?? 'unknown'})`);
    }
    await ctx.hub.dispatch(node.id, 'agent.update', {
      targetVersion: release.version,
      downloadUrl: `${controllerUrl}/install/bin/${platform}`,
      sha256: pinned.sha256,
      strategy: 'self-replace',
    });
    return { id, targetVersion: release.version, strategy: 'self-replace' };
  }

  // Unreleased builds all say 0.0.0 — pin the image to the controller's commit
  // (CI tags every image `sha-<7>`), else the version tag.
  const tag = release.commit ? `sha-${release.commit.slice(0, 7)}` : release.version;
  const image = opts.image ?? process.env.SWARMY_AGENT_IMAGE ?? `ghcr.io/requestflo/swarmy-agent:${tag}`;
  await ctx.hub.dispatch(node.id, 'agent.update', {
    targetVersion: release.version,
    strategy: 'docker-recreate',
    image,
  });
  return { id, targetVersion: release.version, strategy: 'docker-recreate' };
}

/**
 * Why a node can't be removed right now (null = fine). Removing only drops
 * swarmy's record — so for a still-connected node that is the swarm's last
 * manager, or that runs the control plane itself, it would orphan the swarm
 * or leave the controller unable to manage its own host.
 */
export function removeNodeBlockReason(ctx: OrgContext, id: string): string | null {
  if (!ctx.hub.isOnline(id)) return null;
  const nodes = ctx.hub.nodeInventory(ctx.activeOrgId, true);
  const swarmId = ctx.hub.swarmNodeIdFor(id);
  const self = swarmId ? nodes.find((n) => n.swarmNodeId === swarmId) : undefined;
  const managers = nodes.filter((n) => n.role === 'manager');
  if (self?.role === 'manager' && managers.length <= 1) {
    return 'This is the swarm\'s only manager — add and promote another manager first, then remove it.';
  }
  const hostsControlPlane = ctx.hub
    .latestContainers(id)
    .some((c) => (c.labels?.['com.docker.swarm.service.name'] ?? '') === 'swarmy_controller');
  if (hostsControlPlane) {
    return 'This node runs the swarmy controller — it can\'t be removed from its own dashboard.';
  }
  return null;
}

export async function removeNode(ctx: OrgContext, id: string): Promise<{ id: string; removed: true }> {
  const node = await ctx.db.node.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    select: { id: true },
  });
  if (!node) throw notFound('node', id);
  const reason = removeNodeBlockReason(ctx, id);
  if (reason) throw commandRejected(reason);
  await ctx.db.node.delete({ where: { id } });
  return { id, removed: true };
}
