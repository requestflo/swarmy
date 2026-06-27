/**
 * Pure peer-reconciliation state mapping (epic #6, Phase 2+).
 *
 * The agent pushes a `meshState` telemetry frame; the controller maps it onto a
 * `MeshPeer` row update (status/meshIp/lastSeen). The mapping is pure so it can
 * be unit-tested without a DB or a hub, and reused by both the gateway handler
 * and the reconcile worker.
 */

/** The subset of a `meshState` payload the reconciler reads. */
export interface MeshStateReport {
  driver: string;
  connected: boolean;
  meshIp?: string;
  peerId?: string;
  publicKey?: string;
  error?: string;
  /** ISO string from the agent. */
  lastHandshakeAt?: string;
  /** Epoch ms when the agent sampled. */
  sampledAt: number;
}

/** Mirrors the DB `MeshPeer.status` string domain. */
export type MeshPeerStatus = 'ENROLLING' | 'ENROLLED' | 'CONNECTED' | 'DEGRADED' | 'FAILED';

export interface MeshPeerUpdate {
  status: MeshPeerStatus;
  meshIp: string | null;
  peerId: string | null;
  lastSeen: Date;
}

/**
 * Map a live `meshState` report onto a peer update. A peer is:
 *   - CONNECTED when the client reports an active handshake / connected=true
 *   - DEGRADED  when connected=false but the client is present (transient/relay loss)
 *   - FAILED    when the report carries an error
 */
export function reconcilePeerState(report: MeshStateReport): MeshPeerUpdate {
  let status: MeshPeerStatus;
  if (report.error) status = 'FAILED';
  else if (report.connected) status = 'CONNECTED';
  else status = 'DEGRADED';

  return {
    status,
    meshIp: report.meshIp ?? null,
    peerId: report.peerId ?? null,
    lastSeen: report.lastHandshakeAt
      ? new Date(report.lastHandshakeAt)
      : new Date(report.sampledAt),
  };
}

/**
 * Map a control-plane peer listing (NetBird Admin API `/api/peers`) onto a peer
 * update keyed by node. Used by the reconcile loop when the agent is silent but
 * the control plane still has authoritative liveness.
 */
export interface ControlPlanePeer {
  peerId: string;
  meshIp?: string;
  connected: boolean;
  /** ISO last-seen from the control plane. */
  lastSeen?: string;
}

export function reconcileFromControlPlane(peer: ControlPlanePeer): MeshPeerUpdate {
  return {
    status: peer.connected ? 'CONNECTED' : 'DEGRADED',
    meshIp: peer.meshIp ?? null,
    peerId: peer.peerId,
    lastSeen: peer.lastSeen ? new Date(peer.lastSeen) : new Date(),
  };
}
