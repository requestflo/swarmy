/**
 * PURE: is a point-in-time target inside the window the agent read from the
 * WAL repo? And the plain words for when it is not.
 *
 * Recovery starts from a base backup and cannot stop before that backup
 * finished, so the window starts when the OLDEST base backup finished. It
 * ends at the newest archived change (or when the repo was read, if the WAL
 * could not be listed): recovery cannot replay WAL that was never archived.
 */
import type { DbPitrWindowResult } from '@swarmy/core/protocol';

/** What the restore asks for. */
export interface PitrTargetAsk {
  /** `<stack>/<cluster>` of the source (the words). */
  ref: string;
  targetTime?: string;
  /** A named base backup, or `latest` / absent for "swarmy picks". */
  snapshotId?: string;
}

/** "2026-10-20 03:00:00 UTC" (the input stays as typed when it is not a time). */
export function plainTime(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC` : iso;
}

/** The window in one sentence, or why there is none. */
export function windowWords(ref: string, r: DbPitrWindowResult): string {
  const oldest = r.backups[0];
  if (!r.window || !oldest) {
    return `${ref} has no base backups yet, so there is no point in time to restore it to. Take a base backup first.`;
  }
  const end = r.latestWalAt ? 'its newest archived change' : 'when swarmy checked';
  return (
    `${ref} can be restored to any time from ${plainTime(r.window.from)} (when its oldest base backup, ${oldest.name}, finished) ` +
    `to ${plainTime(r.window.to)} (${end}).`
  );
}

const REFUSED = 'Nothing was restored, saved or stopped:';

/** The refusal message, or null when the target is inside the window. */
export function judgePitrTarget(r: DbPitrWindowResult, ask: PitrTargetAsk): string | null {
  const words = windowWords(ask.ref, r);
  if (!r.window || r.backups.length === 0) return `${REFUSED} ${words}`;
  const named = ask.snapshotId && ask.snapshotId.toLowerCase() !== 'latest' ? ask.snapshotId : undefined;
  const base = named ? r.backups.find((b) => b.name === named) : undefined;
  if (named && !base) return `${REFUSED} there is no base backup named ${named}. ${words}`;
  if (!ask.targetTime) return null;
  const target = Date.parse(ask.targetTime);
  if (!Number.isFinite(target)) return `${REFUSED} "${ask.targetTime}" is not a time. ${words}`;
  if (target < Date.parse(r.window.from)) {
    return `${REFUSED} ${plainTime(ask.targetTime)} is before the oldest base backup of ${ask.ref} finished. ${words}`;
  }
  if (target > Date.parse(r.window.to)) {
    const past = r.latestWalAt ? 'its newest archived change' : 'the time swarmy checked';
    return `${REFUSED} ${plainTime(ask.targetTime)} is after ${past}. ${words}`;
  }
  if (base && target < Date.parse(base.finishTime)) {
    return (
      `${REFUSED} ${plainTime(ask.targetTime)} is before the base backup ${base.name} finished (${plainTime(base.finishTime)}), ` +
      'so a restore from it cannot stop there. Pick a later time, or let swarmy pick the base backup.'
    );
  }
  return null;
}
