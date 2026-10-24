/**
 * The verdict of the mesh control-plane move drill (cluster e2e step
 * `mesh-control-move`, apps/e2e/cluster/steps/mesh-control-drill.ts), kept
 * pure so the step and this file's test agree on the numbers. No imports: the
 * e2e harness pulls this file in on its own; move-drill.test.ts pins
 * MOVE_WINDOW to the lease the agent runs (@swarmy/core/protocol MESH_LEASE).
 *
 * The drill: (1) a clean move A → B; peers re-attach and setup keys minted
 * before and after the move both enrol. (2) Partition B (now the old node of
 * a second move) and move to C: B's agent can't renew, so it kills its
 * Litestream TTL − margin after its last confirmed renewal (sent at most one
 * renew interval before the cut). C takes the lease only after watching B's
 * write sit unchanged for a full TTL, so C's Litestream starts at least the
 * margin after B's was killed. B's NetBird keeps running while it is cut off
 * (silence never stops it: raft may ride the mesh); when the partition heals,
 * B sees C's lease and stops it. One control plane after.
 */

export const MOVE_WINDOW = { ttlMs: 60_000, renewEveryMs: 10_000, marginMs: 8_000 } as const;

export interface MoveDrillObservation {
  cleanMove: {
    restored: boolean | null;
    epochBefore: number | null;
    epochAfter: number | null;
    holderAfter: string | null;
    target: string;
    /** swarmy-mesh-control still runs on the node it moved away from. */
    oldStillRuns: boolean;
  };
  peers: { total: number; connected: number };
  setupKeys: { mintedBefore: boolean; mintedAfter: boolean };
  partition: {
    /** When the cut went up, on the old node's clock (ms since epoch). */
    partitionAt: number;
    /** The old node's Litestream State.FinishedAt (its clock); null = still running. */
    oldReplicaStoppedAt: number | null;
    /** Its exit code: 137 = SIGKILL, no final sync. */
    oldReplicaExit: number | null;
    /** The new node's Litestream State.StartedAt (its clock); null = never started. */
    newReplicaStartedAt: number | null;
    epochBefore: number | null;
    epochAfter: number | null;
    holderAfter: string | null;
    target: string;
    /** After the heal: the old node stopped its control plane on its own. */
    oldStoppedAfterHeal: boolean;
    /** swarmy-mesh-control containers running across the cluster after the heal. */
    controlPlanesAfterHeal: number;
  };
}

export interface MoveDrillVerdict {
  ok: boolean;
  problems: string[];
  /** Partition → the old Litestream killed, ms. */
  fencedAfterMs: number | null;
  /** Old Litestream killed → new one started, ms. */
  handoverGapMs: number | null;
}

/** Latest the old node may kill Litestream after the cut: TTL − margin, plus clock slack. */
export function replicaFenceBoundMs(skewMs = 3_000, w = MOVE_WINDOW): number {
  return w.ttlMs - w.marginMs + skewMs;
}

const s = (ms: number) => `${Math.round(ms / 1000)}s`;

function epochMoved(problems: string[], what: string, before: number | null, after: number | null): void {
  if (before == null || after == null || after <= before) problems.push(`${what}: the lease epoch did not move forward (${before ?? '?'} → ${after ?? '?'})`);
}

export function judgeMoveDrill(o: MoveDrillObservation, skewMs = 3_000, w = MOVE_WINDOW): MoveDrillVerdict {
  const problems: string[] = [];
  const c = o.cleanMove;
  if (c.restored !== true) problems.push(`clean move: the target did not restore from the replica (restored: ${c.restored})`);
  if (c.holderAfter !== c.target) problems.push(`clean move: the lease is held by ${c.holderAfter ?? 'nobody'}, not the target ${c.target}`);
  epochMoved(problems, 'clean move', c.epochBefore, c.epochAfter);
  if (c.oldStillRuns) problems.push('clean move: the old node still runs swarmy-mesh-control');
  if (o.peers.connected < o.peers.total) problems.push(`peers: ${o.peers.connected}/${o.peers.total} re-attached to the moved control plane`);
  if (!o.setupKeys.mintedBefore) problems.push('a setup key minted before the move no longer enrols a peer');
  if (!o.setupKeys.mintedAfter) problems.push('a setup key minted after the move does not enrol a peer');

  const p = o.partition;
  const fencedAfterMs = p.oldReplicaStoppedAt == null ? null : p.oldReplicaStoppedAt - p.partitionAt;
  const handoverGapMs = p.oldReplicaStoppedAt == null || p.newReplicaStartedAt == null ? null : p.newReplicaStartedAt - p.oldReplicaStoppedAt;
  if (fencedAfterMs == null) problems.push("partition: the cut-off node's Litestream never stopped");
  else if (fencedAfterMs > replicaFenceBoundMs(skewMs, w)) problems.push(`partition: Litestream stopped ${s(fencedAfterMs)} after the cut; the bound is ${s(replicaFenceBoundMs(skewMs, w))}`);
  else if (fencedAfterMs < -skewMs) problems.push(`partition: Litestream stopped ${s(-fencedAfterMs)} BEFORE the cut (a different stop?)`);
  if (p.oldReplicaStoppedAt != null && p.oldReplicaExit !== 137) problems.push(`partition: the old Litestream exited ${p.oldReplicaExit ?? '?'}, not 137 (killed, no final sync)`);
  if (p.newReplicaStartedAt == null) problems.push('partition: the new node never started replicating');
  else if (handoverGapMs != null && handoverGapMs < w.marginMs - skewMs) {
    problems.push(`partition: the new Litestream started ${s(handoverGapMs)} after the old one stopped; it must wait at least the ${s(w.marginMs)} margin (two writers?)`);
  }
  if (p.holderAfter !== p.target) problems.push(`partition: the lease is held by ${p.holderAfter ?? 'nobody'}, not the target ${p.target}`);
  epochMoved(problems, 'partition', p.epochBefore, p.epochAfter);
  if (!p.oldStoppedAfterHeal) problems.push('after the heal: the old node kept running swarmy-mesh-control');
  if (p.controlPlanesAfterHeal !== 1) problems.push(`after the heal: ${p.controlPlanesAfterHeal} control planes run, want 1`);
  return { ok: problems.length === 0, problems, fencedAfterMs, handoverGapMs };
}
