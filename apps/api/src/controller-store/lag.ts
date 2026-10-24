/**
 * Replication lag for control.db, measured rather than guessed: how old is
 * the oldest local write that the replica does not hold yet?
 *
 * Litestream v0.5's control socket can't answer that by itself. `/list`'s
 * `last_sync_at` stops moving both when the replica is failing AND when the
 * store is idle, and `/debug/sync-status` has no WAL size. So the monitor
 * (lag-monitor.ts) samples two TXIDs:
 *   - local, every second: Litestream's own position (`GET /txid`), cheap;
 *   - replica, every few seconds: the highest TXID among the LTX files in
 *     the bucket (`readReplicaHead`, the listing boot reads), always right
 *     AFTER a local sample, so "replica ≥ local" proves it held everything.
 *
 * Lag is judged as of the last replica read: the read time minus when we first
 * saw the oldest local TXID it didn't hold yet (resolution: the local
 * sampling interval). While replica reads fail, the lag keeps growing from
 * that oldest unshipped write, because nothing proves it shipped.
 * PURE: the clock is passed in (monotonic ms).
 */

export interface LagState {
  /** Local TXIDs above the replica head, oldest first, with when we first saw each. */
  seen: Array<{ txid: bigint; at: number }>;
  local: bigint | null;
  replica: bigint | null;
  /** The local TXID sampled just before the last good replica read. */
  localAtRead: bigint | null;
  replicaReadAt: number | null;
  /** Why the last replica read failed (cleared by the next good one). */
  replicaError: string | null;
}

/** Keep at most this many unshipped samples (a day-long outage at 1/s would be 86 400). */
export const MAX_SEEN = 500;

export function emptyLag(): LagState {
  return { seen: [], local: null, replica: null, localAtRead: null, replicaReadAt: null, replicaError: null };
}

export function noteLocal(s: LagState, txid: bigint, now: number): LagState {
  const last = s.seen[s.seen.length - 1];
  const above = s.replica == null || txid > s.replica;
  if (!above || (last && txid <= last.txid)) return { ...s, local: txid };
  let seen = [...s.seen, { txid, at: now }];
  // Over the cap: drop the second-oldest. The oldest is the one lag is measured from.
  if (seen.length > MAX_SEEN) seen = [seen[0]!, ...seen.slice(2)];
  return { ...s, local: txid, seen };
}

export function noteReplica(s: LagState, head: bigint, now: number): LagState {
  return {
    ...s,
    replica: head,
    localAtRead: s.local,
    replicaReadAt: now,
    replicaError: null,
    seen: s.seen.filter((e) => e.txid > head),
  };
}

export function noteReplicaError(s: LagState, error: string): LagState {
  return { ...s, replicaError: error };
}

export interface LagReading {
  /** Age of the oldest write not yet in the replica: 0 = caught up, null = unknown. */
  lagMs: number | null;
  /** Local transactions the replica didn't hold at the last read (null = unknown). */
  behindTxns: number | null;
  /** How long ago the replica was last read successfully (null = never). */
  replicaCheckedAgoMs: number | null;
  localTxid: bigint | null;
  replicaTxid: bigint | null;
  replicaError: string | null;
}

/** A whole, non-negative number of ms (the clock is performance.now()). */
const ms = (v: number) => Math.max(0, Math.round(v));

export function readLag(s: LagState, now: number): LagReading {
  const base = {
    localTxid: s.local,
    replicaTxid: s.replica,
    replicaError: s.replicaError,
    replicaCheckedAgoMs: s.replicaReadAt == null ? null : ms(now - s.replicaReadAt),
  };
  if (s.replica == null || s.replicaReadAt == null) return { ...base, lagMs: null, behindTxns: null };
  if (s.replicaError) {
    // Can't see the replica: everything above the last known head may be unshipped.
    const oldest = s.seen[0];
    if (s.local == null) return { ...base, lagMs: null, behindTxns: null };
    return { ...base, lagMs: oldest ? ms(now - oldest.at) : 0, behindTxns: Math.max(0, Number(s.local - s.replica)) };
  }
  if (s.localAtRead == null) return { ...base, lagMs: null, behindTxns: null };
  if (s.replica >= s.localAtRead) return { ...base, lagMs: 0, behindTxns: 0 };
  const readAt = s.replicaReadAt;
  const oldest = s.seen.find((e) => e.at <= readAt);
  return {
    ...base,
    lagMs: oldest ? ms(readAt - oldest.at) : null,
    behindTxns: Number(s.localAtRead - s.replica),
  };
}
