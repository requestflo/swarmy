/**
 * Swarm-over-mesh migration — the PURE half (planner, label snapshot/restore,
 * data-pin remap). The IO runner lives in `mesh-migration.service.ts`.
 *
 * Why this is a migration and not a toggle: Docker fixes a node's
 * `--advertise-addr` / `--data-path-addr` at join time, so moving an existing
 * node onto its mesh IP means leave → rejoin. A rejoin mints a NEW swarm node
 * id and a blank node spec — so the node's labels (region, roles, public IP,
 * canvas…) must be snapshotted and restored, and every service pinned by the
 * OLD id (`swarmy.db.node`, `swarmy.cache.node`, … + `node.id==<old>`) must be
 * re-pointed at the new one.
 *
 * Rules (all enforced here, unit-tested in `mesh-migration.plan.test.ts`):
 *   - One node at a time. Managers first get an enroll-only pass — a manager
 *     must have a route to the workers' mesh IPs before any worker advertises one.
 *   - Fewer than 3 managers ⇒ managers NEVER move (demoting the only manager
 *     destroys the swarm; with 2, a demote leaves no quorum margin). They stay
 *     on their address, must be publicly reachable, and are only enrolled.
 *   - ≥3 managers ⇒ managers move after the workers, followers first, the
 *     leader last (demote → worker path → promote).
 *   - The node hosting the swarmy controller moves last within its tier.
 *   - Pinned data members / the last schedulable node produce warnings the
 *     operator must acknowledge; offline or unreported nodes block.
 */
import { PINNED_DATA_LABELS } from '@swarmy/core';
import type { SwarmNodeInfo } from '@swarmy/core/protocol';

export type MigrationDirection = 'onto-mesh' | 'off-mesh';

/** Where a node's swarm membership stands relative to the requested direction. */
export type PlannedAction =
  /** leave → rejoin on the target address. */
  | 'move'
  /** Stays on its address (single/dual manager) — only enrolled in the mesh. */
  | 'enroll-only'
  /** Stays on its address and is already a mesh peer — nothing to do. */
  | 'stays-put'
  /** Already on the target address. */
  | 'already';

export interface PlanNodeInput {
  /** swarmy enrollment id (`Node.id`). */
  nodeId: string;
  hostname: string;
  online: boolean;
  /** Live swarm node (Docker truth) — undefined = not reported yet. */
  swarm?: SwarmNodeInfo;
  /** Mesh IP from the live peer map (agent meshState telemetry). */
  meshIp?: string | null;
  /** Mesh client reports connected. */
  meshConnected: boolean;
  /** Runs the `swarmy_controller` service task. */
  hostsController?: boolean;
}

export interface PlanServiceInput {
  name: string;
  labels: Record<string, string>;
}

export interface PlannedNode {
  nodeId: string;
  hostname: string;
  kind: 'manager' | 'worker';
  action: PlannedAction;
  /** Current swarm advertise address. */
  addr: string | null;
  meshIp: string | null;
  onMesh: boolean;
  leader: boolean;
  /** Plain-words why (drives the UI's per-node line). */
  reason: string;
  /** Managed data members pinned to this node by swarm id. */
  pinned: string[];
}

export interface MigrationPlan {
  direction: MigrationDirection;
  managerCount: number;
  /** <3 managers: they stay on their (public) addresses. */
  managersStay: boolean;
  /** In execution order. `already`/`stays-put` entries are listed for status only. */
  nodes: PlannedNode[];
  warnings: string[];
  blockers: string[];
}

/** NetBird / Tailscale / Headscale hand out CGNAT space: 100.64.0.0/10. */
export function isMeshCidr(addr: string | null | undefined): boolean {
  if (!addr) return false;
  const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(addr.trim());
  if (!m) return false;
  const second = Number(m[1]);
  return second >= 64 && second <= 127;
}

/** Strip a `:port` suffix from a swarm addr. */
export function hostOf(addr: string | null | undefined): string | null {
  if (!addr) return null;
  return addr.replace(/:\d+$/, '') || null;
}

/** Is this swarm node advertising on the mesh? */
export function isOnMesh(addr: string | null | undefined, meshIp: string | null | undefined): boolean {
  const host = hostOf(addr);
  if (!host) return false;
  if (meshIp && host === meshIp) return true;
  return isMeshCidr(host);
}

/** Services pinned (by label VALUE) to a swarm node id. */
export function pinnedServicesOn(services: readonly PlanServiceInput[], swarmNodeId: string): string[] {
  return services
    .filter((s) => PINNED_DATA_LABELS.some((k) => s.labels[k] === swarmNodeId))
    .map((s) => s.name)
    .sort();
}

export function planMeshMigration(input: {
  direction: MigrationDirection;
  nodes: readonly PlanNodeInput[];
  services: readonly PlanServiceInput[];
}): MigrationPlan {
  const { direction } = input;
  const warnings: string[] = [];
  const blockers: string[] = [];

  const managerCount = input.nodes.filter((n) => n.swarm?.role === 'manager').length;
  const managersStay = managerCount < 3;
  const schedulable = input.nodes.filter(
    (n) => n.swarm && n.swarm.availability === 'active' && n.swarm.status === 'ready',
  ).length;

  const planned: (PlannedNode & { hostsController: boolean })[] = [];
  for (const n of input.nodes) {
    if (!n.swarm) {
      blockers.push(`${n.hostname} hasn't reported its swarm membership yet — wait for it to come online.`);
      continue;
    }
    const kind = n.swarm.role;
    const addr = hostOf(n.swarm.addr);
    const meshIp = n.meshIp ?? null;
    const onMesh = isOnMesh(addr, meshIp);
    const pinned = pinnedServicesOn(input.services, n.swarm.swarmNodeId);
    const base = {
      nodeId: n.nodeId,
      hostname: n.hostname,
      kind,
      addr,
      meshIp,
      onMesh,
      leader: n.swarm.leader,
      pinned,
      hostsController: Boolean(n.hostsController),
    };

    let action: PlannedAction;
    let reason: string;
    if (kind === 'manager' && managersStay) {
      if (direction === 'onto-mesh' && !n.meshConnected) {
        action = 'enroll-only';
        reason = onMesh
          ? 'Manager already advertises on the mesh; its mesh client is (re)enrolled.'
          : 'Manager joins the mesh. It keeps its address — re-form it on its mesh IP (`swarmy-agent rejoin --force`) before moving other nodes.';
      } else {
        action = 'stays-put';
        reason =
          direction === 'onto-mesh'
            ? onMesh
              ? 'Manager already advertises its mesh IP — stays put.'
              : 'Manager is on the mesh but advertises its public address — re-form it on its mesh IP (`swarmy-agent rejoin --force`) before moving other nodes.'
            : 'Manager stays on its address.';
        if (direction === 'off-mesh' && onMesh) {
          warnings.push(
            `${n.hostname} is a manager advertising on the mesh — with fewer than 3 managers it can't be moved, so the mesh must stay on for it.`,
          );
        }
      }
    } else if (direction === 'onto-mesh' ? onMesh : !onMesh) {
      action = 'already';
      reason = direction === 'onto-mesh' ? 'Already on the mesh data-path.' : 'Already off the mesh.';
    } else {
      action = 'move';
      reason =
        direction === 'onto-mesh'
          ? `Briefly drained, then rejoined on its mesh IP${kind === 'manager' ? ' (demote → rejoin → promote)' : ''}.`
          : `Briefly drained, then rejoined on its own address${kind === 'manager' ? ' (demote → rejoin → promote)' : ''}.`;
    }

    if ((action === 'move' || action === 'enroll-only') && !n.online) {
      blockers.push(`${n.hostname} is offline — bring it back before moving the swarm.`);
    }
    if (action === 'move') {
      for (const svc of pinned) {
        warnings.push(
          `${svc} is pinned to ${n.hostname}: it stops while the node moves (about a minute), then restarts on the same node with its data. The pin follows the node's new swarm id.`,
        );
      }
      if (schedulable <= 1) {
        warnings.push(
          `${n.hostname} is the only schedulable node — every service stops while it moves.`,
        );
      }
      if (n.hostsController) {
        warnings.push(
          `${n.hostname} runs the swarmy controller: the dashboard blips while it moves; the migration resumes on its own.`,
        );
      }
      if (direction === 'off-mesh' && !n.swarm.labels['swarmy.node.public-ip'] && !n.swarm.labels['swarmy.node.public-ip.override']) {
        warnings.push(
          `${n.hostname} reported no public address — off the mesh, a NAT’d node can't be reached by the managers.`,
        );
      }
    }
    planned.push({ ...base, action, reason });
  }

  if (direction === 'onto-mesh' && managersStay) {
    // A manager off the mesh + workers on mesh IPs = broken encrypted overlays:
    // Docker keys each IPsec SA on the ADVERTISED addresses, but the manager's
    // packets to a mesh IP leave wt0 from ITS mesh IP, so they never match and
    // are dropped — the swarmy overlay (every ingress route) goes dark.
    // Verified live on DigitalOcean. The manager has to move first.
    const offMesh = planned.filter((p) => p.kind === 'manager' && !p.onMesh);
    if (offMesh.length && planned.some((p) => p.action === 'move')) {
      for (const m of offMesh) {
        blockers.push(
          `${m.hostname} is the swarm's manager and advertises ${m.addr ?? 'a non-mesh address'}. Nodes on mesh IPs can't use the encrypted swarmy network with it (IPsec is keyed on advertised addresses), which breaks ingress. Move the manager first: on ${m.hostname} run \`swarmy-agent rejoin --force\` (re-forms the swarm on its mesh IP, keeping services and data), then run this again.`,
        );
      }
    }
  }

  // Order: staying managers (enrolled first) → workers → moving managers (followers, then leader).
  // The controller host goes last within its tier.
  const tier = (p: PlannedNode): number =>
    p.kind === 'manager' && (p.action === 'enroll-only' || p.action === 'stays-put') ? 0 : p.kind === 'worker' ? 1 : 2;
  const ordered = planned
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      const t = tier(a.p) - tier(b.p);
      if (t !== 0) return t;
      const lead = Number(a.p.leader) - Number(b.p.leader);
      if (lead !== 0) return lead;
      const ctl = Number(a.p.hostsController) - Number(b.p.hostsController);
      if (ctl !== 0) return ctl;
      return a.i - b.i;
    })
    .map(({ p }) => {
      const { hostsController: _h, ...rest } = p;
      return rest;
    });

  return { direction, managerCount, managersStay, nodes: ordered, warnings, blockers };
}

// ── Label snapshot / restore ─────────────────────────────────────────────────

/** What a leave→rejoin destroys and we must put back on the new node id. */
export interface NodeSpecSnapshot {
  swarmNodeId: string;
  role: 'manager' | 'worker';
  availability: 'active' | 'pause' | 'drain';
  labels: Record<string, string>;
  addr: string | null;
}

export function snapshotNodeSpec(info: SwarmNodeInfo): NodeSpecSnapshot {
  return {
    swarmNodeId: info.swarmNodeId,
    role: info.role,
    // We drain it ourselves; a node the operator had drained stays drained.
    availability: info.availability,
    labels: { ...info.labels },
    addr: hostOf(info.addr),
  };
}

/**
 * Labels to write onto the rejoined node: everything in the snapshot the new
 * node doesn't already carry with the same value. Empty-string values are
 * kept — they're swarmy's "role off" encoding (`updateSwarmNode` can't delete).
 */
export function labelsToRestore(
  snapshot: NodeSpecSnapshot,
  current: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(snapshot.labels)) {
    if (current?.[k] !== v) out[k] = v;
  }
  return out;
}

// ── Pin remap (the swarm node id CHANGES on rejoin) ──────────────────────────

/** Label keys that carry a swarm node id as a placement declaration. */
const PIN_KEY = /^swarmy\.[a-z0-9-]+\.(node|avoidNode)$/;

export interface PinRemap {
  service: string;
  /** Label key → new swarm node id. */
  setLabels: Record<string, string>;
}

/** Which services must be re-pointed from `oldId` to `newId`. Pure. */
export function planPinRemap(
  services: readonly PlanServiceInput[],
  oldId: string,
  newId: string,
): PinRemap[] {
  if (!oldId || !newId || oldId === newId) return [];
  const out: PinRemap[] = [];
  for (const s of services) {
    const setLabels: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.labels)) {
      if (v === oldId && (PIN_KEY.test(k) || PINNED_DATA_LABELS.includes(k))) setLabels[k] = newId;
    }
    if (Object.keys(setLabels).length > 0) out.push({ service: s.name, setLabels });
  }
  return out.sort((a, b) => a.service.localeCompare(b.service));
}

/** Rewrite `node.id==<old>` / `node.id!=<old>` constraints onto `newId`. Pure. */
export function remapConstraints(
  constraints: readonly string[] | undefined,
  oldId: string,
  newId: string,
): string[] | undefined {
  if (!constraints) return undefined;
  return constraints.map((c) => {
    const m = /^(node\.id\s*[!=]=\s*)(\S+)$/.exec(c.trim());
    return m && m[2] === oldId ? `${m[1]}${newId}` : c;
  });
}
