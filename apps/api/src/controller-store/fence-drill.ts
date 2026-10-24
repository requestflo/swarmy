/**
 * The verdict of the P3 partition drill ("partition the old node and confirm
 * it self-fences"), kept pure so the cluster e2e step
 * (apps/e2e/cluster/steps/controller-drills.ts) and this file's test agree on
 * the numbers. No imports: the e2e harness pulls this file in on its own;
 * fence-drill.test.ts pins FENCE_WINDOW to lease.ts so the two can't drift.
 *
 * Bounds, from lease.ts. The holder's last confirmed renewal was sent at most
 * one renew interval before the partition, and it fences TTL − margin after
 * that renewal was SENT. So it fences between (TTL − margin − renew) and
 * (TTL − margin) after the partition, plus the 1 s watchdog tick. A new holder
 * takes over only after watching the old write sit unchanged for a full TTL,
 * so it starts at least `margin` after the old one fenced.
 *
 * The epic's original target was "self-fences within 30 s" (TTL 30 s). QA-022
 * doubled the TTL so a 20 s link blip no longer fences a healthy controller;
 * the drill reports both, and judges against the design bound.
 */

export const FENCE_WINDOW = {
  ttlMs: 60_000,
  renewEveryMs: 10_000,
  marginMs: 8_000,
  watchdogTickMs: 1_000,
} as const;

/** The epic's original "self-fences within 30 s" (reported, not judged). */
export const EPIC_FENCE_TARGET_MS = 30_000;

export interface FenceDrillObservation {
  /** When the partition went up, on the OLD node's clock (ms since epoch). */
  partitionAt: number;
  /** The old controller's "controller store: FENCED" log line (old node's clock), null = never. */
  fencedAt: number | null;
  /** The old controller container's exit code (null = still running / unknown). */
  exitCode: number | null;
  /** The new controller's "lease acquired" log line (new node's clock), null = no takeover seen. */
  takeoverAt: number | null;
  oldEpoch: number | null;
  newEpoch: number | null;
}

export interface FenceDrillVerdict {
  ok: boolean;
  problems: string[];
  /** Partition → fence, ms (null = never fenced). */
  fencedAfterMs: number | null;
  /** Fence → takeover, ms (null = no takeover). */
  handoverGapMs: number | null;
  meetsEpicTarget: boolean;
}

/** Latest the holder may fence after the partition: TTL − margin + the watchdog tick + clock slack. */
export function fenceBoundMs(skewMs = 3_000, w = FENCE_WINDOW): number {
  return w.ttlMs - w.marginMs + w.watchdogTickMs + skewMs;
}

export function judgeFenceDrill(o: FenceDrillObservation, skewMs = 3_000, w = FENCE_WINDOW): FenceDrillVerdict {
  const problems: string[] = [];
  const fencedAfterMs = o.fencedAt == null ? null : o.fencedAt - o.partitionAt;
  const handoverGapMs = o.fencedAt == null || o.takeoverAt == null ? null : o.takeoverAt - o.fencedAt;
  const s = (ms: number) => `${Math.round(ms / 1000)}s`;
  if (fencedAfterMs == null) problems.push('the old controller never logged FENCED');
  else if (fencedAfterMs > fenceBoundMs(skewMs, w)) problems.push(`fenced ${s(fencedAfterMs)} after the partition; the design bound is ${s(fenceBoundMs(skewMs, w))}`);
  else if (fencedAfterMs < -skewMs) problems.push(`FENCED was logged ${s(-fencedAfterMs)} BEFORE the partition (a different fence?)`);
  if (o.exitCode !== 70) problems.push(`the old controller exited ${o.exitCode ?? 'never'}, not 70 (fenced)`);
  if (o.takeoverAt == null) problems.push('no new controller took the lease on the majority side');
  else if (handoverGapMs != null && handoverGapMs < w.marginMs - skewMs) {
    problems.push(`the new controller took the lease ${s(handoverGapMs)} after the old one fenced; it must wait at least the ${s(w.marginMs)} margin (two writers?)`);
  }
  if (o.takeoverAt != null && (o.newEpoch == null || o.oldEpoch == null || o.newEpoch <= o.oldEpoch)) {
    problems.push(`the lease epoch did not move forward (${o.oldEpoch ?? '?'} → ${o.newEpoch ?? '?'})`);
  }
  return {
    ok: problems.length === 0,
    problems,
    fencedAfterMs,
    handoverGapMs,
    meetsEpicTarget: fencedAfterMs != null && fencedAfterMs <= EPIC_FENCE_TARGET_MS,
  };
}

/** A Docker RFC 3339 time (nanoseconds; Date.parse wants at most milliseconds) → ms, NaN if unreadable. */
export function parseDockerTime(s: string): number {
  return Date.parse(s.trim().replace(/(\.\d{3})\d+/, '$1'));
}

/** `2026-10-24T17:31:01.123456789Z <message>` (docker logs --timestamps) → ms, for the first line matching. */
export function logLineAt(logs: string, match: RegExp): { at: number; line: string } | null {
  for (const raw of logs.split('\n')) {
    const sp = raw.indexOf(' ');
    if (sp < 0 || !match.test(raw.slice(sp + 1))) continue;
    const at = parseDockerTime(raw.slice(0, sp));
    if (Number.isFinite(at)) return { at, line: raw.slice(sp + 1) };
  }
  return null;
}
