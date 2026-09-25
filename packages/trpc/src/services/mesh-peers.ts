/**
 * Live mesh peers (epic-docker-native-state P1: `MeshPeer` is derived, never
 * stored).
 *
 * A peer's status, mesh IP, provider peer id and last-seen come from the
 * agent's `meshState` push (every 20 s) and from `applyMesh` results at
 * enrolment. They are held here, process-local, the same way the hub holds
 * node and service state. After a controller restart the map refills within
 * one `meshState` tick; `mesh.service.listPeers` also cross-checks the control
 * plane's `listPeers` so a configured NetBird fills gaps in the meantime.
 *
 * The provider peer id is only ever needed while the peer is live (nothing
 * revokes a peer by a remembered id), so it lives here too: no node label.
 */
import { reconcilePeerState, type MeshPeerStatus, type MeshStateReport } from '@swarmy/mesh';
import type { MeshControlStatus } from '@swarmy/core/protocol';

/** `ENROLLING` while `applyMesh` is in flight; the rest mirror `reconcilePeerState`. */
export type LiveMeshPeerStatus = MeshPeerStatus;

export interface LiveMeshPeer {
  orgId: string;
  nodeId: string;
  /** Wire driver name (`netbird`, `headscale`). */
  driver: string;
  status: LiveMeshPeerStatus;
  meshIp: string | null;
  peerId: string | null;
  lastSeen: Date | null;
  /** When this controller process first saw the peer. */
  since: Date;
}

/** Statuses that mean "reachable on the mesh right now". */
export const MESH_CONNECTED = new Set<string>(['CONNECTED']);

export class MeshPeerStore {
  private readonly byNode = new Map<string, LiveMeshPeer>();

  get(nodeId: string): LiveMeshPeer | undefined {
    return this.byNode.get(nodeId);
  }

  /** The org's live peers, newest first. */
  forOrg(orgId: string): LiveMeshPeer[] {
    return [...this.byNode.values()]
      .filter((p) => p.orgId === orgId)
      .sort((a, b) => b.since.getTime() - a.since.getTime());
  }

  /** Merge a patch onto a node's peer, creating it when absent. */
  upsert(
    orgId: string,
    nodeId: string,
    patch: Partial<Omit<LiveMeshPeer, 'orgId' | 'nodeId' | 'since'>>,
  ): LiveMeshPeer {
    const prev = this.byNode.get(nodeId);
    const next: LiveMeshPeer = {
      orgId,
      nodeId,
      driver: patch.driver ?? prev?.driver ?? 'none',
      status: patch.status ?? prev?.status ?? 'ENROLLING',
      meshIp: patch.meshIp !== undefined ? patch.meshIp : (prev?.meshIp ?? null),
      peerId: patch.peerId !== undefined ? patch.peerId : (prev?.peerId ?? null),
      lastSeen: patch.lastSeen !== undefined ? patch.lastSeen : (prev?.lastSeen ?? null),
      since: prev?.since ?? new Date(),
    };
    this.byNode.set(nodeId, next);
    return next;
  }

  delete(nodeId: string): void {
    this.byNode.delete(nodeId);
  }

  /** Test seam. */
  clear(): void {
    this.byNode.clear();
  }
}

/** The controller's single live peer map. */
export const meshPeers = new MeshPeerStore();

/**
 * Fold one agent `meshState` report into the live map. A node that joined the
 * mesh BEFORE registering (installer node #1, mesh-first "Add a node"
 * one-liners) was never enrolled from the dashboard, so its first connected
 * sample with an IP creates the peer; any other report for an unknown node is
 * a no-op (a node with the mesh client stopped isn't a peer).
 */
export function reconcileMeshPeer(
  orgId: string,
  nodeId: string,
  report: MeshStateReport & { control?: MeshControlStatus },
  store: MeshPeerStore = meshPeers,
): LiveMeshPeer | null {
  if (report.control) meshControlLive.report(orgId, nodeId, report.control);
  if (!store.get(nodeId) && !(report.connected && report.meshIp)) return null;
  const update = reconcilePeerState(report);
  return store.upsert(orgId, nodeId, {
    driver: report.driver,
    status: update.status,
    // A transient sample without an IP keeps the last known one.
    meshIp: update.meshIp ?? store.get(nodeId)?.meshIp ?? null,
    peerId: update.peerId ?? store.get(nodeId)?.peerId ?? null,
    lastSeen: update.lastSeen,
  });
}

// ── The self-hosted control plane's live status (meshState.control) ──────────

export interface LiveMeshControl {
  nodeId: string;
  status: MeshControlStatus;
  at: Date;
}

/**
 * Where the org's self-hosted NetBird runs and how it is doing, from the
 * hosting node's own `meshState` (telemetry, never stored). Two nodes may
 * report during a move; the freshest wins in `get`.
 */
export class MeshControlLiveStore {
  private readonly byOrg = new Map<string, Map<string, LiveMeshControl>>();

  report(orgId: string, nodeId: string, status: MeshControlStatus, at = new Date()): void {
    const m = this.byOrg.get(orgId) ?? new Map<string, LiveMeshControl>();
    m.set(nodeId, { nodeId, status, at });
    this.byOrg.set(orgId, m);
  }

  /** Every node that reported one in the last `maxAgeMs` (default 90 s), running first. */
  all(orgId: string, maxAgeMs = 90_000, now = Date.now()): LiveMeshControl[] {
    return [...(this.byOrg.get(orgId)?.values() ?? [])]
      .filter((c) => now - c.at.getTime() <= maxAgeMs)
      .sort((a, b) => Number(b.status.running) - Number(a.status.running) || b.at.getTime() - a.at.getTime());
  }

  get(orgId: string, maxAgeMs?: number): LiveMeshControl | undefined {
    return this.all(orgId, maxAgeMs)[0];
  }

  clear(): void {
    this.byOrg.clear();
  }
}

export const meshControlLive = new MeshControlLiveStore();
