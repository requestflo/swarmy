/**
 * The controller's single-writer lease: the decisions, kept pure so they can be
 * tested without Docker.
 *
 * Where the lease lives: the `swarmy.controller.lease` label on the
 * controller's own service, written through a manager agent with a
 * version-checked `service update` (see protocol/controllerService.ts). Raft
 * makes every write a compare-and-swap, and a write needs quorum.
 *
 * The rules:
 *  - Epoch fencing. Every acquire bumps the epoch. Renewals and releases must
 *    name the epoch they hold, so a controller that was superseded can't write
 *    the lease back.
 *  - Expiry is judged by OBSERVATION, not by comparing clocks. A challenger
 *    may take over a lease only after it has watched the same lease write sit
 *    unchanged for a full TTL on its own monotonic clock.
 *  - The holder fences EARLY. It stops writing at its last successful renewal
 *    + TTL − margin, timed from when that renewal was SENT. The challenger's
 *    watch starts only after it has seen that write, so the old holder is
 *    always gone at least `margin` before the new one starts.
 */
import { sameLeaseWrite, type ControllerLeaseRecord } from '@swarmy/core/protocol';

/**
 * TTL = 6 renew intervals. At 30 s (3 intervals) one 20 s blip in the
 * manager agent's WebSocket fenced an idle, healthy controller (QA-022: three
 * exit-70s in two hours). The holder now rides out ~50 s of silence, retrying
 * every LEASE_RETRY_MS; a challenger waits out the holder's own announced
 * `ttlMs`, so a longer TTL is exactly as safe, only slower to fail over.
 */
export const LEASE_TTL_MS = 60_000;
export const LEASE_RENEW_EVERY_MS = 10_000;
/** A renewal that got no confirmed answer is retried this soon. */
export const LEASE_RETRY_MS = 2_000;
/** How far before its TTL the holder fences itself. */
export const LEASE_FENCE_MARGIN_MS = 8_000;

export interface LeaseSelf {
  /** Our Swarm task id. */
  holder: string;
  /** Our Swarm node id. */
  node: string;
}

/** The last lease write we saw, and when (our monotonic clock) we first saw it. */
export interface LeaseObservation {
  record: ControllerLeaseRecord | null;
  firstSeenAt: number;
}

/** Fold a fresh read into the observation: a changed write restarts the clock. */
export function observe(
  prev: LeaseObservation | null,
  record: ControllerLeaseRecord | null,
  now: number,
): LeaseObservation {
  if (prev && sameLeaseWrite(prev.record, record)) return prev;
  return { record, firstSeenAt: now };
}

export type TakeoverDecision =
  | { take: true; expect: ControllerLeaseRecord | null; why: 'free' | 'released' | 'ours' | 'same-node' | 'expired' }
  | { take: false; waitMs: number; holder: ControllerLeaseRecord };

/**
 * May we take the lease now?
 *
 * `same-node`: the previous holder ran on THIS node. The controller runs
 * `replicas: 1` with `stop-first`, so Swarm has already stopped that task
 * (or it crashed) before starting us here. Without this, every crash-restart
 * would wait a full TTL for nothing.
 */
export function takeoverDecision(obs: LeaseObservation, self: LeaseSelf, now: number): TakeoverDecision {
  const r = obs.record;
  if (!r) return { take: true, expect: null, why: 'free' };
  if (r.released) return { take: true, expect: r, why: 'released' };
  if (r.holder === self.holder) return { take: true, expect: r, why: 'ours' };
  if (r.node && r.node === self.node) return { take: true, expect: r, why: 'same-node' };
  const waited = now - obs.firstSeenAt;
  if (waited >= r.ttlMs) return { take: true, expect: r, why: 'expired' };
  return { take: false, waitMs: r.ttlMs - waited, holder: r };
}

/** When a holder whose last good write was SENT at `lastOkSentAt` must stop. */
export function fenceDeadline(
  lastOkSentAt: number,
  ttlMs = LEASE_TTL_MS,
  marginMs = LEASE_FENCE_MARGIN_MS,
): number {
  return lastOkSentAt + ttlMs - marginMs;
}

export function mustFence(now: number, lastOkSentAt: number, ttlMs = LEASE_TTL_MS, marginMs = LEASE_FENCE_MARGIN_MS): boolean {
  return now >= fenceDeadline(lastOkSentAt, ttlMs, marginMs);
}

/** The floor for our next epoch: never below anything we have seen anywhere. */
export function minEpoch(...seen: Array<number | null | undefined>): number {
  return Math.max(0, ...seen.map((e) => (typeof e === 'number' && Number.isFinite(e) ? e : 0)));
}

/**
 * Is a renewal result still ours? Epoch fencing on the controller side too: a
 * lease that came back with another holder or a different epoch means we were
 * superseded, even if the agent said ok.
 */
export function stillHeld(
  result: { ok: boolean; lease: ControllerLeaseRecord | null },
  self: LeaseSelf,
  epoch: number,
): boolean {
  return result.ok && !!result.lease && result.lease.holder === self.holder && result.lease.epoch === epoch && !result.lease.released;
}

/**
 * What a renewal answer proves. Only POSITIVE evidence of another holder is a
 * loss:
 *  - `held`: the lease is still ours and the write landed. Adopt what came back
 *    (a same-holder lease at another epoch is our own earlier write, never a loss).
 *  - `lost`: the live lease names a different holder.
 *  - `free`: nobody holds it (label removed, or released): re-acquire it.
 *  - `unknown`: no answer (timeout, agent offline), or a CAS race on a lease
 *    that is still ours. Retry. The watchdog alone decides when silence has
 *    gone on too long.
 */
export type RenewalVerdict =
  | { kind: 'held'; lease: ControllerLeaseRecord }
  | { kind: 'lost'; lease: ControllerLeaseRecord }
  | { kind: 'free'; lease: ControllerLeaseRecord | null }
  | { kind: 'unknown' };

export function renewalVerdict(
  res: { ok: boolean; lease: ControllerLeaseRecord | null; reason?: string } | null,
  self: LeaseSelf,
): RenewalVerdict {
  if (!res) return { kind: 'unknown' };
  const l = res.lease;
  if (res.reason === 'not-found' || res.reason === 'not-system') return { kind: 'unknown' };
  if (!l || l.released) return { kind: 'free', lease: l };
  if (l.holder === self.holder) return res.ok ? { kind: 'held', lease: l } : { kind: 'unknown' };
  return { kind: 'lost', lease: l };
}

/**
 * Should silence (no confirmed renewal) fence us now? On a single-manager
 * swarm no second controller can run while this task holds the slot
 * (`replicas: 1`, stop-first, manager-only placement), so silence alone is no
 * evidence of another holder: keep running and keep retrying. `managers` =
 * manager nodes in the swarm, or null when unknown (then be conservative).
 */
export function fenceOnSilence(now: number, lastOkSentAt: number, managers: number | null): boolean {
  if (managers === 1) return false;
  return mustFence(now, lastOkSentAt);
}
