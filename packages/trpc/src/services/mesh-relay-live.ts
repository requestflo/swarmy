/**
 * Edge relays' live status (relays on edges), from each relay node's own
 * `meshState.relay` push: telemetry in memory, never stored (same rule as the
 * control plane's `meshControlLive`). Refills within one 20 s tick after a
 * controller restart. Leaf module, so mesh-peers.ts can feed it.
 */
import type { MeshRelayStatus } from '@swarmy/core/protocol';

export interface LiveMeshRelay {
  nodeId: string;
  status: MeshRelayStatus;
  at: Date;
}

export class MeshRelayLiveStore {
  private readonly byOrg = new Map<string, Map<string, LiveMeshRelay>>();

  report(orgId: string, nodeId: string, status: MeshRelayStatus, at = new Date()): void {
    const m = this.byOrg.get(orgId) ?? new Map<string, LiveMeshRelay>();
    m.set(nodeId, { nodeId, status, at });
    this.byOrg.set(orgId, m);
  }

  /** The node's report, if it is fresher than `maxAgeMs` (default 90 s). */
  get(orgId: string, nodeId: string, maxAgeMs = 90_000, now = Date.now()): LiveMeshRelay | undefined {
    const r = this.byOrg.get(orgId)?.get(nodeId);
    return r && now - r.at.getTime() <= maxAgeMs ? r : undefined;
  }

  /** Every fresh report for the org, by node id. */
  all(orgId: string, maxAgeMs = 90_000, now = Date.now()): LiveMeshRelay[] {
    return [...(this.byOrg.get(orgId)?.values() ?? [])]
      .filter((r) => now - r.at.getTime() <= maxAgeMs)
      .sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1));
  }

  /** A node that stopped its relay: forget it at once (no stale "running"). */
  forget(orgId: string, nodeId: string): void {
    this.byOrg.get(orgId)?.delete(nodeId);
  }

  clear(): void {
    this.byOrg.clear();
  }
}

export const meshRelayLive = new MeshRelayLiveStore();
