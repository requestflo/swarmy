/**
 * Pure DR target-selection (epic: volumes-dr, P2 — restore-on-recovery).
 *
 * No IO. Given the set of nodes and their health, decide where to restore a
 * volume that was stranded on a now-offline node. The reconcile worker feeds it
 * live node status; this function owns the placement policy so it can be tested
 * in isolation. Policy: prefer an online manager (CSI/cluster-volume re-publish
 * needs a manager), else any online worker; avoid the dead node; prefer the
 * least-loaded healthy node (fewest already-assigned restores).
 */

export interface ReconcileNode {
  id: string;
  role: 'MANAGER' | 'WORKER';
  online: boolean;
  /** Restores already scheduled onto this node this pass (load balancing). */
  assignedRestores: number;
}

export interface SelectInput {
  /** The node that went offline / whose volume is stranded. */
  deadNodeId: string;
  nodes: ReconcileNode[];
}

/**
 * Pick the best healthy node to restore onto, or `null` if none is available.
 * Managers outrank workers; within a tier, fewer assigned restores wins; ties
 * break by node id for determinism.
 */
export function selectRestoreTarget(input: SelectInput): string | null {
  const candidates = input.nodes.filter((n) => n.online && n.id !== input.deadNodeId);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const roleRank = (n: ReconcileNode) => (n.role === 'MANAGER' ? 0 : 1);
    if (roleRank(a) !== roleRank(b)) return roleRank(a) - roleRank(b);
    if (a.assignedRestores !== b.assignedRestores) return a.assignedRestores - b.assignedRestores;
    return a.id < b.id ? -1 : 1;
  });
  return candidates[0]!.id;
}
