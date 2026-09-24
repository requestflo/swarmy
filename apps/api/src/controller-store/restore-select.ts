/**
 * Restore-on-boot: which copy of control.db should this controller start
 * from? Pure, so every case is unit-tested. boot.ts gathers the facts and
 * carries out the decision BEFORE anything opens the database.
 *
 * Lineage, not timestamps. Each controller that replicates first writes a
 * WRITER MARKER, `{holder, epoch}`, both next to its local file and into the
 * replica. On boot:
 *  - If the local marker equals the replica's marker, this node's file IS the
 *    replica's newest lineage. It may even be ahead of the replica by the last
 *    unshipped writes. Keep it.
 *  - If they differ, another controller wrote to the replica after this file
 *    was last current (the controller moved away and back). The local file is
 *    stale. Move it aside and restore.
 * Priority is replica, then controller bundle, then fresh. We never start
 * fresh while a replica we can't reach might hold the data.
 */

export interface WriterMarker {
  holder: string;
  epoch: number;
  node?: string;
  hostname?: string;
  at?: number;
}

export function sameWriter(a: WriterMarker | null, b: WriterMarker | null): boolean {
  if (!a || !b) return a === b;
  return a.holder === b.holder && a.epoch === b.epoch;
}

export type BootSourceKind = 'keep-local' | 'restore-replica' | 'restore-bundle' | 'fresh' | 'wait' | 'refuse';

export interface BootDecision {
  kind: BootSourceKind;
  reason: string;
  /** Keep the existing local file as `control.db.stale-<ts>` before restoring over it. */
  moveAsideLocal?: boolean;
}

export interface BootFacts {
  local: { exists: boolean; marker: WriterMarker | null };
  replica: {
    configured: boolean;
    /** The listing/marker read worked. */
    reachable: boolean;
    /** At least one LTX file exists. */
    hasData: boolean;
    marker: WriterMarker | null;
  };
  bundle: { configured: boolean };
  /** A controller has run in this swarm before (lease label or markers seen). */
  priorController: boolean;
  /** Operator override (SWARMY_BOOT_SOURCE). */
  forced?: 'local' | 'replica' | 'bundle' | 'fresh';
  /** SWARMY_ALLOW_FRESH=1: accept an empty store even though one existed before. */
  allowFresh?: boolean;
}

export function selectBootSource(f: BootFacts): BootDecision {
  if (f.forced) return forcedDecision(f);

  const { local, replica, bundle } = f;
  const replicaUsable = replica.configured && replica.reachable && replica.hasData;

  if (local.exists) {
    if (replicaUsable && !sameWriter(local.marker, replica.marker)) {
      return {
        kind: 'restore-replica',
        moveAsideLocal: true,
        reason: `local file is stale: it was last written by ${describe(local.marker)}, the replica by ${describe(replica.marker)}`,
      };
    }
    if (replica.configured && !replica.reachable) {
      return { kind: 'keep-local', reason: 'replica unreachable; keeping the local file (replication waits until it is checked)' };
    }
    return { kind: 'keep-local', reason: replicaUsable ? 'local file is the replica’s current lineage' : 'no replica data; local file is the only copy' };
  }

  if (replicaUsable) return { kind: 'restore-replica', reason: 'no local file; the replica has data' };
  if (replica.configured && !replica.reachable) {
    return { kind: 'wait', reason: 'no local file and the replica is unreachable; refusing to start empty while it may hold the data' };
  }
  if (bundle.configured) return { kind: 'restore-bundle', reason: 'no local file and no replica data; restoring the latest controller bundle' };
  if (f.priorController && !f.allowFresh) {
    return {
      kind: 'refuse',
      reason:
        'no local file, no replica and no bundle, but a controller ran in this swarm before. ' +
        'Starting empty would orphan every node. Set SWARMY_ALLOW_FRESH=1 to start fresh anyway.',
    };
  }
  return { kind: 'fresh', reason: 'first boot: nothing to restore' };
}

function forcedDecision(f: BootFacts): BootDecision {
  switch (f.forced) {
    case 'local':
      return { kind: f.local.exists ? 'keep-local' : 'fresh', reason: 'forced by SWARMY_BOOT_SOURCE=local' };
    case 'replica':
      return { kind: 'restore-replica', moveAsideLocal: f.local.exists, reason: 'forced by SWARMY_BOOT_SOURCE=replica' };
    case 'bundle':
      return { kind: 'restore-bundle', moveAsideLocal: f.local.exists, reason: 'forced by SWARMY_BOOT_SOURCE=bundle' };
    default:
      return { kind: 'fresh', moveAsideLocal: f.local.exists, reason: 'forced by SWARMY_BOOT_SOURCE=fresh' };
  }
}

function describe(m: WriterMarker | null): string {
  if (!m) return 'an unmarked writer';
  return `epoch ${m.epoch}${m.hostname ? ` on ${m.hostname}` : ''}`;
}

/**
 * The check right before replication starts, once we hold the lease. The
 * replica must still be exactly what boot saw: the same writer marker and no
 * newer transactions. Otherwise an old controller kept shipping after our
 * restore (a partition), and replicating now would bury its writes under a
 * snapshot of our older file. We exit instead, and the next boot re-restores.
 */
export function replicationPrecheck(input: {
  bootMarker: WriterMarker | null;
  bootHeadTxid: bigint;
  nowMarker: WriterMarker | null;
  nowHeadTxid: bigint;
}): { ok: true } | { ok: false; reason: string } {
  if (!sameWriter(input.bootMarker, input.nowMarker)) {
    return { ok: false, reason: `replica writer changed since boot (${describe(input.bootMarker)} → ${describe(input.nowMarker)})` };
  }
  if (input.nowHeadTxid > input.bootHeadTxid) {
    return { ok: false, reason: `replica advanced since boot (txid ${input.bootHeadTxid} → ${input.nowHeadTxid})` };
  }
  return { ok: true };
}
