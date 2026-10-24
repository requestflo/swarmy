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
 * Still open (the plan's lease): a returning node runs the old control plane
 * until the controller hears from it (≤ one 30 s tick, longer if the
 * controller is dark too). A raft-backed `swarmy.mesh.control.lease` the
 * container must renew would close that window without the controller.
 */
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
