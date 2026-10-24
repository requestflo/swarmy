/**
 * Fence a control plane that comes back where it no longer belongs (plan
 * §2.5 move, step 1). `moveControlPlane` stops the old one when its agent is
 * alive; when it was dark, nothing did. Its agent's 10 s supervisor restarts
 * the old `swarmy-mesh-control` (and its Litestream writer, into the SAME
 * replica) from the local copy as soon as the box is back. The reconcile
 * stops it on its first report.
 *
 * Pure. Never fences while the current control plane isn't up and healthy:
 * a stale `controlNodeId` must never take down the only running one.
 *
 * Belt and braces since the raft lease (@swarmy/core/protocol
 * mesh-control-lease.ts): the returning node's own agent now fences itself
 * on its first lease read, before Litestream gets a config, with or without
 * the controller. This catches what the lease can't see: a worker host
 * (unleased) or an agent with the lease switched off.
 */
import type { MeshControlStatus } from '@swarmy/core/protocol';
import type { LiveMeshControl } from './mesh-peers';

export function staleControlPlanes(reports: readonly LiveMeshControl[], controlNodeId: string | null | undefined): string[] {
  if (!controlNodeId) return [];
  const current = reports.find((r) => r.nodeId === controlNodeId);
  if (!current?.status.running || !current.status.healthy) return [];
  return reports
    .filter((r) => r.nodeId !== controlNodeId && r.status.running)
    .map((r) => r.nodeId)
    .sort();
}

/** Every node a move must stop first: the one we think hosts it, and any other that reports one running. */
export function movingAwayFrom(from: string | null | undefined, reports: readonly LiveMeshControl[], target: string): string[] {
  const nodes = new Set(reports.filter((r) => r.status.running).map((r) => r.nodeId));
  if (from) nodes.add(from);
  nodes.delete(target);
  return [...nodes].sort();
}

/** The card's one line about the lease, in plain words (null = nothing to say). */
export function leaseWarning(status: MeshControlStatus | null | undefined): string | null {
  const l = status?.lease;
  if (!l || !status?.running) return null;
  const holder = l.holderHostname ?? l.holderNode ?? 'another server';
  if (l.state === 'lost') return `This server lost the control-plane lease to ${holder} and stopped.`;
  if (l.state === 'waiting') return `Waiting for ${holder} to let go of the control-plane lease (up to a minute after it stops renewing).`;
  if (l.state === 'silent' && !l.replicate) return 'The swarm has not confirmed the control-plane lease lately, so backups to the replica are paused. NetBird keeps running.';
  return null;
}
