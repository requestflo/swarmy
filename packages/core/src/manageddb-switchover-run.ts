import { behindWatermarkBytes, type PrimaryWatermark } from './manageddb-failover';

/**
 * The planned switchover's RUN, as pure decisions (the plan is
 * `manageddb-switchover.ts`; the runner, @swarmy/trpc
 * `manageddb-switchover.run.ts`, does the IO between them):
 *
 *   pause     stamp the request label, put the writer read-only
 *             (`default_transaction_read_only`), end the transactions that
 *             began read-write before that (rolled back, never committed),
 *             CHECKPOINT, read the writer's FINAL flushed position;
 *   catch-up  wait, bounded, until the copy has replayed that position —
 *             timeout ⇒ abort: writes resume, the label goes;
 *   promote   stop the writer; the manageddb reconcile's promotion pass
 *             promotes the requested copy through `decideFailover` (no grace
 *             window, candidates narrowed to the target, the watermark raised
 *             to the final position — never lowered), then repoints the other
 *             copies and the pooler in the same pass — timeout or a HELD
 *             decision ⇒ abort: the old writer starts again, writes resume;
 *   rejoin    the old writer starts as a standby of the new one (the boot
 *             layer moves its data aside and re-clones under the promotion's
 *             rejoin epoch). Slow is not a failure: the switch is done.
 *
 * The request label (`swarmy.db.switchover`) is JSON `{ at, target, finalLsn }`;
 * the older form, a bare ISO time, still parses. A request older than
 * `DB_SWITCHOVER_MAX_AGE_MS` is a run that died: the reconcile lets the writer
 * take writes again and drops the label.
 */

export const SWITCHOVER_DRAIN_TIMEOUT_MS = 60_000;
export const SWITCHOVER_PROMOTE_TIMEOUT_MS = 3 * 60_000;
export const SWITCHOVER_REJOIN_TIMEOUT_MS = 10 * 60_000;

export type SwitchoverPhase = 'pause' | 'catch-up' | 'promote' | 'repoint' | 'rejoin';

/** The progress card's steps, in order, in plain words. */
export const SWITCHOVER_PHASES: readonly { phase: SwitchoverPhase; label: string }[] = [
  { phase: 'pause', label: 'Pause writes' },
  { phase: 'catch-up', label: 'Let the copy catch up' },
  { phase: 'promote', label: 'Make it the writer' },
  { phase: 'repoint', label: 'Point the copies and the pooler at it' },
  { phase: 'rejoin', label: 'The old main copy follows as a standby' },
];

/** SQL the runner sends to the writer (psql -tAc inside its task) and the target. */
export const SWITCHOVER_SQL = {
  freeze: 'ALTER SYSTEM SET default_transaction_read_only = on',
  thaw: 'ALTER SYSTEM RESET default_transaction_read_only',
  reload: 'SELECT pg_reload_conf()',
  endOpenWrites:
    "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid() AND xact_start IS NOT NULL",
  checkpoint: 'CHECKPOINT',
  flushLsn: 'SELECT pg_current_wal_flush_lsn()',
  replayLsn: 'SELECT pg_last_wal_replay_lsn()',
  inRecovery: 'SELECT pg_is_in_recovery()',
} as const;

export type DrainDecision = { kind: 'ready' } | { kind: 'wait'; behindBytes: number | null } | { kind: 'abort'; reason: string };

/** Has the copy replayed the writer's final flushed position yet? */
export function drainDecision(i: { finalLsn: string; replayLsn: string | null; elapsedMs: number; timeoutMs?: number }): DrainDecision {
  const behind = i.replayLsn ? behindWatermarkBytes(i.finalLsn, i.replayLsn) : null;
  if (behind === 0) return { kind: 'ready' };
  if (i.elapsedMs > (i.timeoutMs ?? SWITCHOVER_DRAIN_TIMEOUT_MS)) {
    const gap = behind === null ? 'an unknown amount' : `${behind} bytes`;
    return { kind: 'abort', reason: `the copy was still ${gap} behind the paused main copy, so nothing was switched and writes resumed` };
  }
  return { kind: 'wait', behindBytes: behind };
}

export type PromoteDecision = { kind: 'promoted' } | { kind: 'wait' } | { kind: 'abort'; reason: string };

/** Has the reconcile made the copy the writer, held it, or run out of time? */
export function promoteDecision(i: { targetRole: string | undefined; held: boolean; elapsedMs: number; timeoutMs?: number }): PromoteDecision {
  if (i.targetRole === 'primary') return { kind: 'promoted' };
  if (i.held) return { kind: 'abort', reason: "swarmy's failover rule held the switch (the copy wasn't provably caught up), so the old main copy took the writes back" };
  if (i.elapsedMs > (i.timeoutMs ?? SWITCHOVER_PROMOTE_TIMEOUT_MS)) {
    return { kind: 'abort', reason: 'the copy wasn’t made the writer in time, so the old main copy took the writes back' };
  }
  return { kind: 'wait' };
}

/** Is the old writer running again as a standby? `late` is a warning, never an undo. */
export function rejoinDecision(i: { running: number; elapsedMs: number; timeoutMs?: number }): 'joined' | 'wait' | 'late' {
  if (i.running > 0) return 'joined';
  return i.elapsedMs > (i.timeoutMs ?? SWITCHOVER_REJOIN_TIMEOUT_MS) ? 'late' : 'wait';
}

export interface SwitchoverRequest {
  /** ISO time the run paused writes. */
  at: string;
  /** The member service to promote. */
  target?: string;
  /** Its ONE copy to promote: the swarm node it runs on (a service may run several). */
  copy?: string;
  /** The paused writer's final `pg_current_wal_flush_lsn()`. */
  finalLsn?: string;
}

export function encodeSwitchoverRequest(r: SwitchoverRequest): string {
  return JSON.stringify(r);
}

/** The label value → a request, or null. A bare ISO time (the older form) is `{ at }`. */
export function parseSwitchoverRequest(raw: string | undefined): SwitchoverRequest | null {
  if (!raw) return null;
  if (!raw.trimStart().startsWith('{')) return Number.isFinite(Date.parse(raw)) ? { at: raw } : null;
  try {
    const v = JSON.parse(raw) as Partial<SwitchoverRequest>;
    if (typeof v.at !== 'string' || !Number.isFinite(Date.parse(v.at))) return null;
    return {
      at: v.at,
      ...(typeof v.target === 'string' && v.target ? { target: v.target } : {}),
      ...(typeof v.copy === 'string' && v.copy ? { copy: v.copy } : {}),
      ...(typeof v.finalLsn === 'string' && v.finalLsn ? { finalLsn: v.finalLsn } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The promotion pass's `decideFailover` input under a planned request: only
 * the requested copy is a candidate (its service, and its server when the
 * request names one), and the watermark is the higher of the
 * reconcile's own sample and the paused writer's final position. It is never
 * lowered, and never invented: no sample of its own stays no sample (⇒ hold).
 */
export function plannedPromotion<C extends { service: string; copy?: string }>(
  i: { candidates: C[]; watermark: PrimaryWatermark | null },
  req: SwitchoverRequest | null,
): { candidates: C[]; watermark: PrimaryWatermark | null } {
  if (!req) return i;
  const candidates = req.target
    ? i.candidates.filter((c) => c.service === req.target && (!req.copy || c.copy === req.copy))
    : i.candidates;
  const w = i.watermark;
  const ahead = w && req.finalLsn ? behindWatermarkBytes(req.finalLsn, w.lsn) : null;
  return { candidates, watermark: w && ahead ? { ...w, lsn: req.finalLsn! } : w };
}
