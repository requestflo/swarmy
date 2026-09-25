/**
 * Managed-Postgres failover safety — the pure decision the manageddb-reconcile
 * worker runs once a primary has been unhealthy past the grace window, plus the
 * label contract it shares with `manageddb.service` (pending / confirm).
 *
 * THE RULE (owner decision 2026-09-24 — "no silent data loss on failover"):
 * swarmy auto-promotes a replica ONLY when it is provably caught up — its replay
 * LSN is at (or past) the primary's last known flushed LSN, sampled on the last
 * tick the primary was seen healthy. Anything else — the replica is behind, or
 * the watermark is unknown/stale (controller restarted, the LSN probe failed) —
 * does NOT promote: the worker raises a critical alert + incident, stamps the
 * data-loss window (bytes / seconds behind) on the primary as
 * `swarmy.db.failover.pending`, and waits for an admin to confirm it in the
 * dashboard/API (`swarmy.db.failover.confirm`). A confirmation names the target
 * and the window it accepts; if the window grows past it, the confirmation no
 * longer applies.
 *
 * Per topology: `single` and `active-active` never auto-promote (nothing to
 * promote / other writers already exist); `primary-replica`, `failover` and
 * `geo` are all async streaming replication, so all three are gated by the same
 * rule — `geo` (cross-region) simply trips the confirmation more often.
 *
 * Residual window, stated honestly: the watermark is the last flushed LSN swarmy
 * OBSERVED (one probe per ~15 s healthy tick). Commits flushed on the primary
 * after that probe and never streamed to any replica are invisible to every
 * async scheme; only synchronous replication closes that gap.
 *
 * Pure: no IO. Both the worker and the tRPC service import it from @swarmy/core
 * so the label shapes can't drift.
 */

/** Stamped on the (dead) primary while a failover waits for admin confirmation. */
export const DB_FAILOVER_PENDING_LABEL = 'swarmy.db.failover.pending';
/** Stamped by `manageddb.confirmFailover`; consumed (and cleared) by the worker. */
export const DB_FAILOVER_CONFIRM_LABEL = 'swarmy.db.failover.confirm';

/**
 * Max gap between the watermark sample and the last healthy observation of the
 * primary. The worker probes every healthy tick (15 s); one missed probe makes
 * the watermark stale and therefore not proof.
 */
export const FAILOVER_WATERMARK_MAX_GAP_MS = 20_000;

export type FailoverTopology = 'single' | 'primary-replica' | 'failover' | 'geo' | 'active-active';

/** How a topology fails over: never, or gated by the caught-up rule. */
export function failoverPolicy(topology: FailoverTopology): 'never' | 'gated' {
  return topology === 'single' || topology === 'active-active' ? 'never' : 'gated';
}

/**
 * Can this cluster HONESTLY offer automatic failover right now (QA-058)? A
 * failover survives the primary's node dying only if a caught-up replica
 * lives on ANOTHER server. The promotion is arbitrated by the controller
 * (lease-fenced, a single writer), not by the `-dcs` etcd member, which only
 * observes the leader. Requirements:
 *  - at least 2 ready servers (the replica must not share the primary's);
 *  - at least one read replica declared;
 *  - the primary's data on a pinned persistent volume, which is what keeps the
 *    replica off the primary's server (`swarmy.db.avoidNode`).
 * PURE — the UI shows `reason` and setTopology refuses `failover` on it.
 */
export function failoverReadiness(input: {
  readyNodes: number;
  replicas: number;
  primaryPinned: boolean;
}): { ok: true; survives: string } | { ok: false; reason: string } {
  if (input.readyNodes < 2) {
    return {
      ok: false,
      reason: `Automatic failover needs at least 2 servers, so the replica can run on a different one from the primary. This cluster has ${input.readyNodes}.`,
    };
  }
  if (input.replicas < 1) {
    return { ok: false, reason: 'Automatic failover needs at least 1 read replica to promote. Add a replica first.' };
  }
  if (!input.primaryPinned) {
    return {
      ok: false,
      reason:
        "The primary's data isn't on a pinned persistent volume yet (Migrate storage), so swarmy can't keep the replica off the primary's server.",
    };
  }
  return {
    ok: true,
    survives:
      "Survives the primary's server (or its Postgres) failing: a caught-up replica on another server is promoted. A replica that is behind waits for your confirmation, so no silent data loss.",
  };
}

/** The primary's last known flushed LSN (`pg_current_wal_flush_lsn()`). */
export interface PrimaryWatermark {
  lsn: string;
  /** epoch ms the sample was taken. */
  sampledAt: number;
}

export interface FailoverCandidate {
  service: string;
  /** Running task count — 0 disqualifies (nothing to exec `pg_ctl promote` in). */
  running: number;
  /** `pg_last_wal_replay_lsn()` measured on the replica (null = unmeasured). */
  replayLsn: string | null;
  /** `now() - pg_last_xact_replay_timestamp()` seconds — informational only. */
  lagSeconds: number | null;
}

/**
 * An admin's go-ahead. `acceptBehindBytes` is the data-loss window the admin
 * saw and accepted; `'unknown'` accepts an unmeasurable window (any loss).
 */
export interface FailoverConfirmation {
  target: string;
  acceptBehindBytes: number | 'unknown';
  /** Who confirmed (user id) and when (ISO) — carried into the audit row. */
  by?: string;
  at?: string;
}

/** What the worker stamps while it waits: the window the admin must accept. */
export interface PendingFailover {
  target: string;
  /** Bytes the target trails the watermark; null = not provable (unknown). */
  behindBytes: number | null;
  /** Last measured replay lag of the target, seconds (informational). */
  behindSeconds: number | null;
  /** Why it didn't auto-promote (plain words, shown in the dashboard). */
  reason: string;
  /** ISO time the wait began. */
  since: string;
}

export type FailoverDecision =
  | { kind: 'never'; reason: string }
  | { kind: 'wait'; reason: string }
  | {
      kind: 'promote';
      target: string;
      behindBytes: number | null;
      behindSeconds: number | null;
      /** true = promoted on an admin confirmation (a known/accepted loss window). */
      confirmed: boolean;
    }
  | {
      kind: 'confirm';
      target: string;
      behindBytes: number | null;
      behindSeconds: number | null;
      reason: string;
    };

export interface DecideFailoverInput {
  topology: FailoverTopology;
  candidates: FailoverCandidate[];
  /** Last flushed-LSN sample taken while the primary was healthy (null = none). */
  watermark: PrimaryWatermark | null;
  /** epoch ms the primary was last observed healthy (null = never, this process). */
  lastHealthyAt: number | null;
  confirmation: FailoverConfirmation | null;
}

function lsnPos(lsn: string): number | null {
  const m = /^([0-9A-Fa-f]+)\/([0-9A-Fa-f]+)$/.exec(lsn.trim());
  if (!m) return null;
  return Number.parseInt(m[1]!, 16) * 0x1_0000_0000 + Number.parseInt(m[2]!, 16);
}

/** Bytes `replayLsn` trails `watermarkLsn` (>= 0), or null when either is unparseable. */
export function behindWatermarkBytes(watermarkLsn: string, replayLsn: string): number | null {
  const w = lsnPos(watermarkLsn);
  const r = lsnPos(replayLsn);
  if (w === null || r === null) return null;
  return Math.max(0, w - r);
}

/** True when the watermark was sampled on (about) the last healthy tick. */
export function watermarkIsFresh(
  watermark: PrimaryWatermark | null,
  lastHealthyAt: number | null,
  maxGapMs: number = FAILOVER_WATERMARK_MAX_GAP_MS,
): boolean {
  if (!watermark || lastHealthyAt === null) return false;
  return lastHealthyAt - watermark.sampledAt <= maxGapMs;
}

/** Does an admin confirmation cover this window? */
export function confirmationCovers(
  c: FailoverConfirmation,
  behindBytes: number | null,
): boolean {
  if (c.acceptBehindBytes === 'unknown') return true;
  return behindBytes !== null && behindBytes <= c.acceptBehindBytes;
}

/**
 * Decide what to do with a primary that is past its grace window.
 * Deterministic: same input ⇒ same decision.
 */
export function decideFailover(input: DecideFailoverInput): FailoverDecision {
  if (failoverPolicy(input.topology) === 'never') {
    return {
      kind: 'never',
      reason:
        input.topology === 'single'
          ? 'single has no replica to promote'
          : 'active-active already has other writable primaries',
    };
  }
  const running = input.candidates.filter((c) => c.running > 0);
  if (running.length === 0) return { kind: 'wait', reason: 'no running replica to promote' };

  const fresh = watermarkIsFresh(input.watermark, input.lastHealthyAt);
  const scored = running.map((c) => ({
    c,
    behind: fresh && c.replayLsn ? behindWatermarkBytes(input.watermark!.lsn, c.replayLsn) : null,
  }));
  const inf = Number.POSITIVE_INFINITY;
  scored.sort(
    (a, b) =>
      (a.behind ?? inf) - (b.behind ?? inf) ||
      (a.c.lagSeconds ?? inf) - (b.c.lagSeconds ?? inf) ||
      a.c.service.localeCompare(b.c.service),
  );
  const best = scored[0]!;

  if (best.behind === 0) {
    return {
      kind: 'promote',
      target: best.c.service,
      behindBytes: 0,
      behindSeconds: best.c.lagSeconds,
      confirmed: false,
    };
  }

  // An admin may pick any running replica; the confirmation must cover ITS window.
  const conf = input.confirmation;
  if (conf) {
    const chosen = scored.find((s) => s.c.service === conf.target);
    if (chosen && confirmationCovers(conf, chosen.behind)) {
      return {
        kind: 'promote',
        target: chosen.c.service,
        behindBytes: chosen.behind,
        behindSeconds: chosen.c.lagSeconds,
        confirmed: true,
      };
    }
  }

  const reason = !input.watermark || input.lastHealthyAt === null
    ? "the primary's last flushed position is unknown (no sample since the controller started), so no replica can be proven caught up"
    : !fresh
      ? "the primary's last flushed-position sample is stale, so no replica can be proven caught up"
      : best.behind === null
        ? 'no replica reported its replay position, so none can be proven caught up'
        : `the most caught-up replica is ${best.behind} bytes behind the primary's last flushed position`;
  return {
    kind: 'confirm',
    target: best.c.service,
    behindBytes: best.behind,
    behindSeconds: best.c.lagSeconds,
    reason,
  };
}

// ── label codecs (JSON in a label value; both sides parse defensively) ──────

export function encodePendingFailover(p: PendingFailover): string {
  return JSON.stringify(p);
}

export function parsePendingFailover(raw: string | undefined): PendingFailover | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<PendingFailover>;
    if (typeof v.target !== 'string' || !v.target) return null;
    return {
      target: v.target,
      behindBytes: typeof v.behindBytes === 'number' ? v.behindBytes : null,
      behindSeconds: typeof v.behindSeconds === 'number' ? v.behindSeconds : null,
      reason: typeof v.reason === 'string' ? v.reason : '',
      since: typeof v.since === 'string' ? v.since : '',
    };
  } catch {
    return null;
  }
}

/** Same target + window ⇒ no relabel (keeps a steady wait from churning the service). */
export function pendingFailoverChanged(prev: PendingFailover | null, next: PendingFailover): boolean {
  return (
    !prev ||
    prev.target !== next.target ||
    prev.behindBytes !== next.behindBytes ||
    prev.reason !== next.reason
  );
}

export function encodeFailoverConfirmation(c: FailoverConfirmation): string {
  return JSON.stringify(c);
}

export function parseFailoverConfirmation(raw: string | undefined): FailoverConfirmation | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<FailoverConfirmation>;
    if (typeof v.target !== 'string' || !v.target) return null;
    const a = v.acceptBehindBytes;
    if (a !== 'unknown' && !(typeof a === 'number' && Number.isFinite(a) && a >= 0)) return null;
    return {
      target: v.target,
      acceptBehindBytes: a,
      ...(typeof v.by === 'string' ? { by: v.by } : {}),
      ...(typeof v.at === 'string' ? { at: v.at } : {}),
    };
  } catch {
    return null;
  }
}
