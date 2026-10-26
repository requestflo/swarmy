/**
 * The last WAL check per cluster, in process memory (re-read on demand, never
 * a DB row or a label), so the dashboard, the restore preflight and the
 * Resilience check share one read instead of each running a sidecar.
 */
import type { DbWalVerifyResult } from '@swarmy/core/protocol';

/** How long a read counts at all (the dashboard, the preflight, the Resilience check). */
export const WAL_CHECK_MAX_AGE_MS = 60 * 60_000;
/** A read this fresh is served again instead of running another sidecar. */
export const WAL_CHECK_REUSE_MS = 5 * 60_000;
/** The Resilience page refreshes a cluster's read at most this often. */
export const WAL_CHECK_REFRESH_MS = 30 * 60_000;

const lastRead = new Map<string, { at: number; result: DbWalVerifyResult }>();
const lastTry = new Map<string, number>();
const key = (orgId: string, ref: string) => `${orgId}\u0000${ref}`;

export function rememberWalCheck(orgId: string, ref: string, result: DbWalVerifyResult, now = Date.now()): void {
  lastRead.set(key(orgId, ref), { at: now, result });
}

/** The cluster's last read while it is younger than `maxAgeMs`; null otherwise. */
export function knownWalCheck(orgId: string, ref: string, now = Date.now(), maxAgeMs = WAL_CHECK_MAX_AGE_MS): DbWalVerifyResult | null {
  const hit = lastRead.get(key(orgId, ref));
  if (!hit) return null;
  if (now - hit.at > WAL_CHECK_MAX_AGE_MS) {
    lastRead.delete(key(orgId, ref));
    return null;
  }
  return now - hit.at <= maxAgeMs ? hit.result : null;
}

/** Claim a background refresh of this cluster: true at most once per {@link WAL_CHECK_REFRESH_MS}. */
export function claimWalRefresh(orgId: string, ref: string, now = Date.now()): boolean {
  const k = key(orgId, ref);
  const read = lastRead.get(k);
  if (read && now - read.at < WAL_CHECK_REFRESH_MS) return false;
  const tried = lastTry.get(k);
  if (tried != null && now - tried < WAL_CHECK_REFRESH_MS) return false;
  lastTry.set(k, now);
  return true;
}

/** Tests: forget every read. */
export function resetWalChecks(): void {
  lastRead.clear();
  lastTry.clear();
}
