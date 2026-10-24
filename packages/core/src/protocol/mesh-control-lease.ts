import { z } from 'zod';
import { sameLeaseWrite, type ControllerLeaseRecord, type ControllerServiceResult } from './controllerService';

/**
 * The self-hosted mesh control plane's single-host lease (plan
 * epic-self-hosted-mesh-and-fleets §2.5, move step 1). The same mechanism as
 * the controller store's lease (apps/api/src/controller-store/lease.ts): a
 * raft-backed record, written only by compare-and-swap, with epoch fencing and
 * expiry judged by the challenger's own observation, never by clocks.
 *
 * Where it lives: the `swarmy.mesh.control.lease` label of the Docker config
 * `swarmy-mesh-control-lease`. Config labels are the one part of a config
 * Docker lets you update, version-checked like a service spec, so every write
 * is a CAS in raft and needs quorum. No service, no image, nothing scheduled.
 * The hosting agent writes it through its OWN socket (a manager), so the lease
 * works while the controller is dark.
 *
 * The holder is the swarm node id: an agent restart on the same node keeps it.
 *
 * What it fences (the rules below are pure; the agent applies them):
 *  - Litestream, the only shared writer (the replica), ships only while the
 *    lease is ours and fresh: it gets its config after a confirmed renewal and
 *    is killed (no final sync) TTL − margin after the last one was SENT, so it
 *    is gone before any challenger may take over.
 *  - A node that sees ANOTHER node hold the lease, and was not told to take it
 *    over, stops its control plane and forgets it before Litestream gets a
 *    config: the returning old node of a move.
 *  - Silence alone never stops the NetBird server. The swarm is born on the
 *    mesh: after a cold boot raft may need this very server to regain quorum,
 *    so stopping it on "no answer from raft" could deadlock the cluster.
 *  - Taking over a lease another node holds needs intent (the controller's
 *    apply/restore) AND that node's write unchanged for a full TTL.
 */
export const MESH_CONTROL_LEASE_CONFIG = 'swarmy-mesh-control-lease';
export const MESH_CONTROL_LEASE_LABEL = 'swarmy.mesh.control.lease';

/** The controller store's numbers; apps/api/src/controller-store/mesh-lease-pin.test.ts keeps them equal. */
export const MESH_LEASE = { ttlMs: 60_000, renewEveryMs: 10_000, retryMs: 2_000, marginMs: 8_000 } as const;

export const MeshControlLeaseView = z.object({
  /**
   * held: ours and fresh · silent: raft didn't answer (no quorum, not ready)
   * · waiting: told to host, another node holds it · lost: another node holds
   * it, so this node stopped · unleased: no lease here (a worker, no swarm,
   * or SWARMY_MESH_CONTROL_LEASE=off).
   */
  state: z.enum(['held', 'silent', 'waiting', 'lost', 'unleased']),
  epoch: z.number().int().nonnegative().optional(),
  /** The holder we last saw (swarm node id, hostname). */
  holderNode: z.string().optional(),
  holderHostname: z.string().optional(),
  /** ms since our last confirmed renewal was sent. */
  ageMs: z.number().int().nonnegative().optional(),
  /** Litestream may ship right now. */
  replicate: z.boolean().default(false),
  why: z.string().optional(),
});
export type MeshControlLeaseView = z.infer<typeof MeshControlLeaseView>;

/** The last write we saw, and when (our monotonic clock) we first saw it. */
export interface MeshLeaseObservation {
  record: ControllerLeaseRecord | null;
  firstSeenAt: number;
}

/** Fold a read into the observation: a changed write restarts the clock. */
export function observeMeshLease(prev: MeshLeaseObservation | null, record: ControllerLeaseRecord | null, now: number): MeshLeaseObservation {
  return prev && sameLeaseWrite(prev.record, record) ? prev : { record, firstSeenAt: now };
}

export type MeshLeaseRead = { ok: true; record: ControllerLeaseRecord | null } | { ok: false; why: string };

export type MeshLeaseStep =
  | { do: 'renew'; epoch: number }
  | { do: 'acquire'; expect: ControllerLeaseRecord | null; why: 'free' | 'released' | 'expired' }
  | { do: 'wait'; waitMs: number; holder: ControllerLeaseRecord }
  | { do: 'fence'; holder: ControllerLeaseRecord; why: string }
  | { do: 'nothing'; why: string };

const who = (r: ControllerLeaseRecord) => r.hostname ?? r.node;

/**
 * What a node that holds a control-plane spec does with the lease it just read.
 * `intent` = the controller told this node to host (apply/restore); `obs` has
 * already folded this read in.
 */
export function meshLeaseStep(i: { read: MeshLeaseRead; self: string; intent: boolean; obs: MeshLeaseObservation | null; now: number }): MeshLeaseStep {
  if (!i.read.ok) return { do: 'nothing', why: i.read.why };
  const r = i.read.record;
  if (!r) return { do: 'acquire', expect: null, why: 'free' };
  if (r.holder === i.self) return r.released ? { do: 'acquire', expect: r, why: 'released' } : { do: 'renew', epoch: r.epoch };
  if (!i.intent) {
    const how = r.released ? `released by ${who(r)} at epoch ${r.epoch}` : `held by ${who(r)} (epoch ${r.epoch})`;
    return { do: 'fence', holder: r, why: `the lease is ${how}: this node is no longer the control plane` };
  }
  if (r.released) return { do: 'acquire', expect: r, why: 'released' };
  const waited = i.obs && sameLeaseWrite(i.obs.record, r) ? i.now - i.obs.firstSeenAt : 0;
  if (waited >= r.ttlMs) return { do: 'acquire', expect: r, why: 'expired' };
  return { do: 'wait', waitMs: r.ttlMs - waited, holder: r };
}

/**
 * What a write's answer proves. Only positive evidence of another holder is a
 * loss; a CAS race, a lease that went missing, or no answer is a retry (the
 * fence deadline alone decides when silence has gone on too long).
 */
export function meshLeaseOutcome(
  res: ControllerServiceResult | null,
  self: string,
): { kind: 'held'; lease: ControllerLeaseRecord } | { kind: 'lost'; lease: ControllerLeaseRecord } | { kind: 'retry' } {
  const l = res?.lease;
  if (!res || !l || l.released) return { kind: 'retry' };
  if (l.holder === self) return res.ok ? { kind: 'held', lease: l } : { kind: 'retry' };
  return { kind: 'lost', lease: l };
}

/** When Litestream must be gone: TTL − margin after the last confirmed renewal was SENT. */
export function replicaFenceAt(lastOkSentAt: number, w: { ttlMs: number; marginMs: number } = MESH_LEASE): number {
  return lastOkSentAt + w.ttlMs - w.marginMs;
}

/**
 * May Litestream ship now? With no lease (unleased) as before. Otherwise only
 * inside the fence window of a confirmed renewal, except on a single-manager
 * swarm: only a manager can take the lease, so nobody else can hold it.
 * `managers` = the last known manager count (null = unknown: be conservative).
 */
export function meshMayReplicate(s: { state: MeshControlLeaseView['state']; lastOkSentAt: number | null; managers: number | null }, now: number): boolean {
  if (s.state === 'unleased') return true;
  if (s.state === 'lost' || s.state === 'waiting' || s.lastOkSentAt == null) return false;
  return s.managers === 1 || now < replicaFenceAt(s.lastOkSentAt);
}
