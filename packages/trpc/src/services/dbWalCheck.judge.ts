/**
 * PURE: what a `wal-g wal-verify` read means for point-in-time restore.
 *
 * Recovery starts from a base backup and replays the archived WAL in order,
 * so a segment missing for good (`lost`) stops every replay that reaches it.
 * A time from the gap up to the first base backup taken after it is out of
 * reach; later times are fine again (they start from that newer backup).
 * Segments Postgres has not archived yet (`delayed` / `uploading`) are the
 * newest changes on their way, not a gap.
 */
import type { DbWalCheckView, DbWalGapView } from '@swarmy/core';
import type { DbWalVerifyResult, PitrBaseBackup } from '@swarmy/core/protocol';
import { plainTime } from './dbPitrWindow.judge';

export type WalCheckRead = { status: 'read'; result: DbWalVerifyResult } | { status: 'unsupported'; reason: string };

const EMPTY: Omit<DbWalCheckView, 'source'> = {
  status: null,
  continuousSince: null,
  latestWalAt: null,
  gaps: [],
  pendingSegments: 0,
  timeline: null,
  checkedAt: null,
};

/** The first base backup that STARTED at or after `at` finished at…, or null. */
function nextBaseAfter(backups: readonly PitrBaseBackup[], at: string | null): string | null {
  if (!at) return null;
  const t = Date.parse(at);
  const b = backups.find((x) => Date.parse(x.startTime ?? x.finishTime) >= t);
  return b ? b.finishTime : null;
}

/** The gaps in a read, each with when restores can reach past it again. */
export function walGaps(r: DbWalVerifyResult, backups: readonly PitrBaseBackup[] = r.backups): DbWalGapView[] {
  return r.ranges
    .filter((x) => x.status === 'lost')
    .map((x) => ({
      from: x.from ?? null,
      to: x.to ?? null,
      segments: x.segments,
      startSegment: x.startSegment,
      endSegment: x.endSegment,
      reachableAgainAt: nextBaseAfter(backups, x.to ?? null),
    }));
}

/** PURE: the dashboard view of a read (or of why there is none). */
export function walCheckView(read: WalCheckRead | null): DbWalCheckView {
  if (!read || read.status === 'unsupported') return { source: read ? 'unsupported' : 'none', ...EMPTY };
  const r = read.result;
  const gaps = walGaps(r);
  const found = r.ranges.filter((x) => x.status === 'found');
  const lastLost = r.ranges.map((x) => x.status).lastIndexOf('lost');
  const sinceRange = r.ranges.slice(lastLost + 1).find((x) => x.status === 'found');
  const pending = r.ranges.slice(lastLost + 1).filter((x) => x.status === 'delayed' || x.status === 'uploading');
  return {
    source: 'agent',
    status: gaps.length > 0 ? 'gaps' : 'continuous',
    continuousSince: sinceRange?.from ?? (lastLost < 0 ? (r.backups[0]?.finishTime ?? null) : null),
    latestWalAt: found.at(-1)?.to ?? null,
    gaps,
    pendingSegments: pending.reduce((n, x) => n + x.segments, 0),
    timeline: r.timeline?.status ?? null,
    checkedAt: r.checkedAt,
  };
}

/** One gap in words: "from 13:10 to 13:25 UTC on 2026-10-21". */
export function gapWords(g: DbWalGapView): string {
  const from = g.from ? plainTime(g.from) : 'before the archive could say';
  const to = g.to ? plainTime(g.to) : 'now (nothing archived after it yet)';
  return `from ${from} to ${to}`;
}

/**
 * The refusal for a target time no replay can reach, or null. The span runs
 * from the gap's start to when the first base backup after it finished
 * (forever, while there is none).
 */
export function judgeWalTarget(ref: string, gaps: readonly DbWalGapView[], targetTime: string | undefined): string | null {
  if (!targetTime) return null;
  const t = Date.parse(targetTime);
  if (!Number.isFinite(t)) return null;
  for (const g of gaps) {
    const from = g.from ? Date.parse(g.from) : Number.NEGATIVE_INFINITY;
    const until = g.reachableAgainAt ? Date.parse(g.reachableAgainAt) : Number.POSITIVE_INFINITY;
    if (t <= from || t >= until) continue;
    const back = g.reachableAgainAt
      ? `Times from ${plainTime(g.reachableAgainAt)} on start from the base backup taken after it.`
      : 'Nothing after it can be reached until a new base backup is taken.';
    return (
      `Nothing was restored, saved or stopped: ${plainTime(targetTime)} is out of reach. ` +
      `The WAL archive of ${ref} has a gap ${gapWords(g)} (${g.segments} segment${g.segments === 1 ? '' : 's'} missing), ` +
      `so a replay stops there. ${back} Pick a time before the gap${g.reachableAgainAt ? ' or after that backup' : ''}.`
    );
  }
  return null;
}
