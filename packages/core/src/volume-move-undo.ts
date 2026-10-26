/**
 * Undo a move (board 9) — the PURE rule. A move keeps the old copy on the
 * server it left (`swarmy.move.oldCopies`), recorded with the manifest both
 * sides matched at the final, stopped copy: the move's snapshot point. Undo
 * points the service back at that copy and copies nothing, so it is offered
 * only when nothing would be lost:
 *
 *   - within {@link MOVE_UNDO_WINDOW_HOURS} of the move. After that the copy is
 *     an ordinary old copy, as before: kept, the owner asked after
 *     `OLD_COPY_KEEP_DAYS`, deleted only when they say so;
 *   - the old copy still matches the snapshot point, file by file (nothing
 *     wrote to it on the old server);
 *   - the moved copy still matches it too (nothing the app wrote on the new
 *     server since would be thrown away). The IO half reads it once while the
 *     app runs and again once it is stopped, so a late write still refuses.
 *
 * The IO (manifests, the pause, the re-pin) is `@swarmy/trpc` `volumeMove.undo.ts`.
 */
import { compareManifests, type OldCopy, type VolumeManifest } from './volume-move';

/** How long after a move Undo is offered. */
export const MOVE_UNDO_WINDOW_HOURS = 24;
const WINDOW_MS = MOVE_UNDO_WINDOW_HOURS * 3_600_000;

/** The newest move's old copies, as Undo sees them. */
export interface LastMove {
  moveId: string | null;
  /** Controller node id holding the old copy (where Undo goes back to). */
  source: string;
  /** Controller node id the move went to (null on copies kept before Undo existed). */
  dest: string | null;
  movedAt: string;
  /** Undo is offered until then. */
  until: string;
  copies: OldCopy[];
}

/** The newest move's copies: one move is one source server and one move id (else one `movedAt`). */
export function lastMove(copies: readonly OldCopy[]): LastMove | null {
  const newest = [...copies].sort((a, b) => Date.parse(b.movedAt) - Date.parse(a.movedAt))[0];
  if (!newest) return null;
  const same = copies.filter(
    (c) => c.nodeId === newest.nodeId && (newest.moveId ? c.moveId === newest.moveId : c.movedAt === newest.movedAt),
  );
  return {
    moveId: newest.moveId ?? null,
    source: newest.nodeId,
    dest: newest.to ?? null,
    movedAt: newest.movedAt,
    until: new Date(Date.parse(newest.movedAt) + WINDOW_MS).toISOString(),
    copies: same,
  };
}

/** Is Undo still offered for this move at `now`? */
export function undoOpen(move: Pick<LastMove, 'until'>, now: number): boolean {
  return now <= Date.parse(move.until);
}

/** Until when the old copy of `volume` on `nodeId` can take its service back (null = it can't). */
export function undoUntilFor(copies: readonly OldCopy[], nodeId: string, volume: string, now: number): string | null {
  const m = lastMove(copies);
  const mine = m?.source === nodeId && m.copies.some((c) => c.volume === volume && c.manifest && c.manifest.digest !== 'skipped');
  return m && mine && m.dest && undoOpen(m, now) ? m.until : null;
}

export interface UndoInput {
  move: LastMove | null;
  now: number;
  /** Controller node ids running the service now. */
  runningOn: readonly string[];
  /** A move (or an Undo) is already running on the service. */
  moving: boolean;
  /** The old server is online and accepting work. */
  sourceReady: boolean;
  /** Names for the sentences. */
  names: { service: string; source: string; dest: string };
  /** Manifests read now on the old server, by volume (null = unreadable). Absent until read. */
  sourceNow?: ReadonlyMap<string, VolumeManifest | null>;
  /** Manifests read now on the new server, by volume. Absent until read. */
  destNow?: ReadonlyMap<string, VolumeManifest | null>;
}

export type UndoDecision =
  | { ok: false; reason: string }
  /** Nothing refuses yet: read this side next, or (`go`) put it back. */
  | { ok: true; next: 'read-source' | 'read-dest' | 'go' };

const differs = (now: ReadonlyMap<string, VolumeManifest | null>, copies: readonly OldCopy[]): boolean =>
  copies.some((c) => {
    const m = now.get(c.volume);
    return !m || !c.manifest || compareManifests(c.manifest, m) !== null;
  });

/** May this move be undone, and what has to be read before it can? Every refusal is a plain sentence. */
export function decideUndo(i: UndoInput): UndoDecision {
  const { service, source, dest } = i.names;
  const no = (reason: string): UndoDecision => ({ ok: false, reason });
  if (i.moving) return no(`${service} is already moving.`);
  const m = i.move;
  if (!m) return no(`There is no move of ${service} to undo: swarmy keeps no old copy of it.`);
  if (!undoOpen(m, i.now)) {
    return no(`${service} moved more than ${MOVE_UNDO_WINDOW_HOURS} hours ago, so Undo is off. Its old copy stays on ${source} until you delete it.`);
  }
  if (!m.dest || m.copies.some((c) => !c.manifest || c.manifest.digest === 'skipped')) {
    return no(`swarmy didn't record a file-by-file check of ${service}'s data when it moved, so it can't prove the old copy on ${source} is unchanged.`);
  }
  if (i.runningOn.includes(m.source)) return no(`${service} already runs on ${source}.`);
  if (i.runningOn.length !== 1 || i.runningOn[0] !== m.dest) {
    return no(`${service} isn't running on ${dest} right now, so swarmy can't tell where its newest data is.`);
  }
  if (!i.sourceReady) return no(`${source} isn't ready for work, so ${service} can't go back there now.`);
  if (!i.sourceNow) return { ok: true, next: 'read-source' };
  if (differs(i.sourceNow, m.copies)) {
    return no(`The old copy on ${source} changed after the move, so swarmy can't prove it's the data ${service} left there.`);
  }
  if (!i.destNow) return { ok: true, next: 'read-dest' };
  if (differs(i.destNow, m.copies)) return no(`Writes happened on ${dest} since the move; undoing would lose them.`);
  return { ok: true, next: 'go' };
}

/** The old copies after an Undo: the undone move's copies go, the copies it leaves on `dest` are kept. */
export function copiesAfterUndo(all: readonly OldCopy[], undone: LastMove, left: readonly OldCopy[]): OldCopy[] {
  const key = (c: OldCopy): string => `${c.nodeId}/${c.volume}`;
  const gone = new Set([...undone.copies, ...left].map(key));
  return [...all.filter((c) => !gone.has(key(c))), ...left];
}
