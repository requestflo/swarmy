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
  /**
   * The controller lease as swarm raft had it when this task was created
   * (SWARMY_LEASE_AT_START, readable without the replica), and this task's
   * own swarm node. It proves how far the lineage got even when the replica
   * (Garage) is down.
   */
  lease?: { epoch: number; node?: string; hostname?: string } | null;
  selfNode?: string;
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
      // The replica can't say whether this file is current, but the lease in
      // raft can. A lease epoch past the file's writer epoch, taken on ANOTHER
      // node, means someone wrote after this file (QA-060: a rebooted node came
      // back on epoch 11 while epochs 12–13 ran elsewhere). Starting would serve
      // and write an old lineage, so wait for the replica instead.
      const stale = localBehindLease(local.marker, f.lease ?? null, f.selfNode);
      if (stale) return { kind: 'wait', reason: stale };
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

/**
 * PURE — why the local file is behind the lease, or null. Behind means the
 * lease epoch is past the file's writer epoch AND that later epoch was taken
 * on another node (its writes never reached this node's file). A later epoch
 * on THIS node is this file's own writer (a restart here before replication
 * restamped the marker), so it isn't stale. An unmarked file counts as epoch 0.
 */
export function localBehindLease(
  marker: WriterMarker | null,
  lease: { epoch: number; node?: string; hostname?: string } | null,
  selfNode?: string,
): string | null {
  if (!lease || !Number.isFinite(lease.epoch)) return null;
  const localEpoch = marker?.epoch ?? 0;
  if (lease.epoch <= localEpoch) return null;
  if (lease.node && selfNode && lease.node === selfNode) return null;
  return (
    `the local file was last written at epoch ${localEpoch}, but the lease in raft is at epoch ${lease.epoch}` +
    `${lease.hostname ? ` on ${lease.hostname}` : lease.node ? ` on node ${lease.node}` : ''}, and the replica that holds those writes is unreachable. ` +
    'Refusing to serve an older lineage: waiting for the replica (Swarm retries this task)'
  );
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
