/**
 * Which copy of the mesh control plane's state runs after a restore (a move,
 * or a restore onto a node that hosted it before). PURE, so every case is
 * tested; the agent (apps/agent/src/handlers/mesh-control-restore.ts) gathers
 * the facts with Litestream in a one-shot container and carries the choice out.
 *
 * The newest state wins. A node that hosted the control plane before still
 * has its old NetBird files (peers, setup keys) in its volume, and running
 * them brings back a stale mesh. So the backup wins unless this node's copy
 * is PROVABLY newer:
 *  - By Litestream position. v0.5 numbers transactions (TXIDs) on across a
 *    restore, so the copies are comparable. A local copy continues the
 *    backup's lineage when its own LTX files hold the backup's newest file
 *    (same TXIDs, size and time, so not a same-numbered file written by
 *    another server). Continuing it with as many or more transactions means
 *    nothing else wrote since: keep it.
 *  - With no local position (Litestream never ran here), by time: the copy's
 *    last write is more than `skewMs` after the backup's newest save.
 * Anything else restores, after moving the old files aside (never deleted).
 * An unreachable backup refuses: nothing proves either copy is current.
 */

export interface LtxFile {
  level: number;
  minTxid: bigint;
  maxTxid: bigint;
  size: number;
  /** When it was written, ms (seconds resolution in practice). */
  at: number;
}

export interface RestoreFacts {
  local: {
    /** store.db holds data. */
    hasData: boolean;
    /** Last write to store.db or its WAL, ms on this node's clock. */
    modifiedAt: number | null;
    /** Litestream's own LTX files next to store.db (empty: it never ran here). */
    ltx: LtxFile[];
  };
  replica: { reachable: boolean; error?: string; ltx: LtxFile[] };
}

export type RestoreUse = 'replica' | 'local' | 'fresh' | 'refuse';

export interface RestoreChoice {
  use: RestoreUse;
  /** Move this node's existing files aside before restoring (they are kept, never deleted). */
  moveAside: boolean;
  /** One plain sentence: which copy runs and why. */
  reason: string;
}

export interface RestoreChoiceOpts {
  /** Clock allowance for the time-only fallback. */
  skewMs?: number;
  /** How close two LTX files' times must be to count as the same file. */
  matchMs?: number;
}

const when = (ms: number | null): string => (ms == null ? 'at an unknown time' : `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`);

/** The newest file (highest TXID; the lowest level holds the exact last write). */
export function headOf(ltx: LtxFile[]): LtxFile | null {
  let head: LtxFile | null = null;
  for (const f of ltx) {
    if (!head || f.maxTxid > head.maxTxid || (f.maxTxid === head.maxTxid && f.level < head.level)) head = f;
  }
  return head;
}

export function savedAt(ltx: LtxFile[]): number | null {
  return ltx.length ? Math.max(...ltx.map((f) => f.at)) : null;
}

function continues(local: LtxFile[], head: LtxFile, matchMs: number): boolean {
  return local.some((f) => f.minTxid === head.minTxid && f.maxTxid === head.maxTxid && f.size === head.size && Math.abs(f.at - head.at) <= matchMs);
}

export function chooseRestoreSource(f: RestoreFacts, opts: RestoreChoiceOpts = {}): RestoreChoice {
  const skewMs = opts.skewMs ?? 120_000;
  const matchMs = opts.matchMs ?? 5_000;
  const { local, replica } = f;
  if (!replica.reachable) {
    const why = replica.error ? ` (${replica.error})` : '';
    return {
      use: 'refuse',
      moveAside: false,
      reason: local.hasData
        ? `Couldn't read the backup${why}, so there is no telling whether this server's own copy is current. Nothing was changed; try again once object storage answers.`
        : `Couldn't read the backup${why}, and this server has no copy of its own. Starting empty would drop every server and setup key, so nothing was started.`,
    };
  }
  const head = headOf(replica.ltx);
  const saved = when(savedAt(replica.ltx));
  if (!head) {
    return local.hasData
      ? { use: 'local', moveAside: false, reason: "The backup is empty, so this server's own copy is the only one and runs as it is." }
      : { use: 'fresh', moveAside: false, reason: 'There is no backup yet and this server has no copy, so NetBird starts fresh.' };
  }
  const restore = (why: string): RestoreChoice => ({ use: 'replica', moveAside: local.hasData, reason: `Restored the backup saved ${saved}: ${why}` });
  if (!local.hasData) return restore('this server had no copy of its own.');

  const mine = headOf(local.ltx);
  if (mine) {
    const ahead = mine.maxTxid - head.maxTxid;
    if (ahead >= 0n && continues(local.ltx, head, matchMs)) {
      return {
        use: 'local',
        moveAside: false,
        reason:
          ahead === 0n
            ? `Kept this server's copy: it is the backup's latest save (transaction ${head.maxTxid}).`
            : `Kept this server's copy: it continues the backup's latest save (transaction ${head.maxTxid}) and has ${ahead} newer transaction${ahead === 1n ? '' : 's'} the backup hadn't received.`,
      };
    }
    if (ahead < 0n) return restore(`it is further along (transaction ${head.maxTxid}) than this server's old copy (transaction ${mine.maxTxid}).`);
    return restore(
      `this server's old copy reaches transaction ${mine.maxTxid} but doesn't continue the backup's latest save (transaction ${head.maxTxid}), so another server wrote the backup after it.`,
    );
  }
  const last = savedAt(replica.ltx);
  if (local.modifiedAt != null && last != null && local.modifiedAt > last + skewMs) {
    return {
      use: 'local',
      moveAside: false,
      reason: `Kept this server's copy: it was last written ${when(local.modifiedAt)}, well after the backup's newest save (${saved}).`,
    };
  }
  return restore(`this server's old copy was last written ${when(local.modifiedAt)}, which isn't provably newer.`);
}
