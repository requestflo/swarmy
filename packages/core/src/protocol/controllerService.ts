import { z } from 'zod';
import { CommandId } from './primitives';

/**
 * The controller's own service: its raft-backed single-writer lease and its
 * placement (resilience P3: replicated, floating controller).
 *
 * The controller has no Docker socket, so every change to its own service spec
 * goes through a manager agent as ONE command, `controllerService`, with an
 * `op`. The agent only ever touches a service labelled `swarmy.system=true`
 * and only the fields each op names.
 *
 * The lease lives in the controller service's `Spec.Labels`
 * (`swarmy.controller.lease`, one JSON label). Service-level labels are outside
 * the TaskTemplate, so writing them never restarts the task. Every lease write
 * is `service update ?version=<index>`: Docker rejects a stale index ("update
 * out of sequence"), which makes each write an atomic compare-and-swap in raft.
 * A write also needs raft quorum, so a controller cut off in a minority
 * partition can't renew. It fences itself when its lease runs out (see
 * apps/api/src/controller-store/lease.ts).
 */

const cmd = { commandId: CommandId, timeoutMs: z.number().int().positive().optional() };

/** Service label carrying the lease JSON. */
export const CONTROLLER_LEASE_LABEL = 'swarmy.controller.lease';
/** Node label that keeps the controller off a node (used by "Move controller to…"). */
export const CONTROLLER_AVOID_LABEL = 'swarmy.controller.avoid';
/** Always-on placement constraint: honour the avoid label. Absent label = eligible. */
export const CONTROLLER_AVOID_CONSTRAINT = `node.labels.${CONTROLLER_AVOID_LABEL} != true`;
/** Placement once the store is replicated: any manager. */
export const CONTROLLER_FLOATING_CONSTRAINT = 'node.role == manager';
/** Mount target (under /run/secrets) of the controller-store Docker secret. */
export const CONTROLLER_STORE_SECRET_TARGET = 'control_store';
/** Name family of that secret (`swarmy_control_store.<n>`: secrets are immutable). */
export const CONTROLLER_STORE_SECRET_FAMILY = 'swarmy_control_store';

/** Pinned-to-one-host placement (the default until the store is replicated). */
export function pinnedConstraint(hostname: string): string {
  return `node.hostname == ${hostname}`;
}

/** True for the constraint the placement ops own (pinned or floating). */
export function isControllerPlacementConstraint(c: string): boolean {
  const s = c.replace(/\s+/g, '');
  return s.startsWith('node.hostname==') || s === 'node.role==manager';
}

export const ControllerLeaseRecord = z.object({
  /** The holder's Swarm task id (a restarted controller is a NEW task). */
  holder: z.string().min(1),
  /** Swarm node id the holder runs on. */
  node: z.string(),
  hostname: z.string().optional(),
  /** Fencing token: strictly increases on every acquire, never on renew. */
  epoch: z.number().int().nonnegative(),
  /** Agent wall clock at the last write. Shown in the UI only; expiry is
   *  judged by the challenger's own observation (clock-skew free). */
  renewedAt: z.number().int().nonnegative(),
  ttlMs: z.number().int().positive(),
  /** Set by a clean shutdown: the next controller may take over at once. */
  released: z.boolean().optional(),
});
export type ControllerLeaseRecord = z.infer<typeof ControllerLeaseRecord>;

/** Parse the label value; anything unreadable counts as "no lease". */
export function parseLeaseLabel(value: string | undefined | null): ControllerLeaseRecord | null {
  if (!value) return null;
  try {
    const r = ControllerLeaseRecord.safeParse(JSON.parse(value));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** Two records describe the same lease write (same holder, epoch, renewal). */
export function sameLeaseWrite(a: ControllerLeaseRecord | null, b: ControllerLeaseRecord | null): boolean {
  if (!a || !b) return a === b;
  return a.holder === b.holder && a.epoch === b.epoch && a.renewedAt === b.renewedAt && !!a.released === !!b.released;
}

const holderFields = {
  holder: z.string().min(1),
  node: z.string(),
  hostname: z.string().optional(),
  ttlMs: z.number().int().positive(),
};

export const ControllerServiceOp = z.discriminatedUnion('kind', [
  /**
   * Take the lease. Succeeds when the live label is absent/released, or when it
   * still equals `expect` (the record the caller watched go stale). The new
   * epoch is `max(live epoch, minEpoch) + 1`.
   */
  z.object({
    kind: z.literal('lease.acquire'),
    ...holderFields,
    expect: ControllerLeaseRecord.nullable().optional(),
    /** Highest epoch the caller has seen elsewhere (local file / replica marker). */
    minEpoch: z.number().int().nonnegative().default(0),
  }),
  /** Extend the lease; fails unless the live label is ours at this epoch. */
  z.object({ kind: z.literal('lease.renew'), ...holderFields, epoch: z.number().int().nonnegative() }),
  /** Mark our lease released (clean shutdown). No-op if it is no longer ours. */
  z.object({ kind: z.literal('lease.release'), holder: z.string().min(1), epoch: z.number().int().nonnegative() }),
  /**
   * Point the controller at a controller-store secret and set its placement.
   * Changes the TaskTemplate, so Swarm restarts the controller (stop-first).
   */
  z.object({
    kind: z.literal('configure'),
    /** Secret to mount at /run/secrets/control_store (null = leave as is). */
    storeSecret: z.string().min(1).nullable(),
    placement: z.enum(['floating', 'pinned']),
    /** pinned: the hostname to pin to. */
    pinnedHostname: z.string().min(1).optional(),
  }),
  /**
   * Move the controller: label every manager except the target
   * `swarmy.controller.avoid=true`. Swarm's constraint enforcer then stops the
   * running task (its node no longer matches), and the scheduler places the
   * new one on the target. The new controller clears the labels once it
   * holds the lease. Clearing them evicts nothing.
   */
  z.object({
    kind: z.literal('move'),
    targetNodeId: z.string().min(1),
    /** The node the controller runs on now. Labelled LAST, so the evicted task
     *  can't land on a manager that isn't labelled yet. */
    fromNodeId: z.string().optional(),
  }),
  /** Remove `swarmy.controller.avoid` from every node. Never restarts anything. */
  z.object({ kind: z.literal('move.clear') }),
]);
export type ControllerServiceOp = z.infer<typeof ControllerServiceOp>;

export const ControllerServicePayload = z.object({
  ...cmd,
  /** The controller's service name (from the `{{.Service.Name}}` template). */
  service: z.string().min(1),
  op: ControllerServiceOp,
});
export type ControllerServicePayload = z.infer<typeof ControllerServicePayload>;

export const ControllerServiceMsg = z.object({
  type: z.literal('controllerService'),
  payload: ControllerServicePayload,
});
export type ControllerServiceMsg = z.infer<typeof ControllerServiceMsg>;

type LeaseOp = Extract<ControllerServiceOp, { kind: 'lease.acquire' | 'lease.renew' | 'lease.release' }>;

/**
 * The agent-side decision for a lease op against the LIVE label (pure; the
 * handler then writes `next` with the inspected version index, so a concurrent
 * writer makes the update fail instead of both succeeding).
 *
 *   acquire  live absent/released → epoch+1. Live equal to `expect` → epoch+1
 *            (the caller watched it go stale). Anything else → held.
 *   renew    live must be ours at this epoch and not released → same epoch,
 *            new renewedAt. A higher epoch or another holder → lost.
 *   release  ours at this epoch → released:true (epoch kept, so the next
 *            acquire still moves forward). Not ours → ok, nothing written.
 */
export function decideLeaseWrite(
  live: ControllerLeaseRecord | null,
  op: LeaseOp,
  now: number,
): { next: ControllerLeaseRecord | null; result: ControllerServiceResult } {
  switch (op.kind) {
    case 'lease.acquire': {
      const free = !live || live.released === true;
      const stale = !!op.expect && sameLeaseWrite(live, op.expect);
      if (!free && !stale) return { next: null, result: { ok: false, lease: live, reason: 'held' } };
      const next: ControllerLeaseRecord = {
        holder: op.holder,
        node: op.node,
        ...(op.hostname ? { hostname: op.hostname } : {}),
        epoch: Math.max(live?.epoch ?? 0, op.minEpoch ?? 0) + 1,
        renewedAt: now,
        ttlMs: op.ttlMs,
      };
      return { next, result: { ok: true, lease: next } };
    }
    case 'lease.renew': {
      if (!live || live.holder !== op.holder || live.epoch !== op.epoch || live.released) {
        return { next: null, result: { ok: false, lease: live, reason: 'lost' } };
      }
      const next: ControllerLeaseRecord = { ...live, node: op.node, renewedAt: now, ttlMs: op.ttlMs };
      if (op.hostname) next.hostname = op.hostname;
      return { next, result: { ok: true, lease: next } };
    }
    case 'lease.release': {
      if (!live || live.holder !== op.holder || live.epoch !== op.epoch || live.released) {
        return { next: null, result: { ok: true, lease: live } };
      }
      const next: ControllerLeaseRecord = { ...live, released: true, renewedAt: now };
      return { next, result: { ok: true, lease: next } };
    }
  }
}

export interface ControllerServiceResult {
  ok: boolean;
  /** The live lease after the op (or the one that blocked it). */
  lease: ControllerLeaseRecord | null;
  /** Why ok=false: held by someone else, lost to a newer epoch, or a CAS race. */
  reason?: 'held' | 'lost' | 'conflict' | 'not-found' | 'not-system';
  /** configure / move: whether the controller will be rescheduled. */
  restarting?: boolean;
  /** move / move.clear: nodes whose avoid label changed. */
  labelled?: string[];
}
