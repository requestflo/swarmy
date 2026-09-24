/**
 * Staged ACME DNS-01 challenge TXT records — in-memory, per org.
 *
 * WHY in memory (not the DB, not a label): a challenge lives for the seconds
 * to minutes one ACME order takes, and it is worthless after a controller
 * restart (the order it belongs to is retried from scratch by Caddy). It is
 * zone CONTENT, not zone identity, so it never belongs in `DnsZone`; the
 * snapshot composer folds live challenges into the zone like any derived
 * record (`dns-snapshot.service` `composeZone`). Every entry also expires on
 * its own, so a cleanup that never arrives cannot leave a stale TXT forever.
 */
import type { StaticDnsRecord } from '@swarmy/core/protocol';

/** A challenge outlives any sane ACME order by this much, then drops. */
export const CHALLENGE_TTL_MS = 20 * 60_000;
/** TXT TTL on the wire — resolvers must not cache a challenge for long. */
export const CHALLENGE_RECORD_TTL = 10;

interface Staged {
  zone: string;
  relName: string;
  value: string;
  expiresAt: number;
}

const byOrg = new Map<string, Map<string, Staged>>();
const key = (zone: string, relName: string, value: string) => `${zone}|${relName}|${value}`;

function prune(orgId: string, now: number): Map<string, Staged> | undefined {
  const m = byOrg.get(orgId);
  if (!m) return undefined;
  for (const [k, s] of m) if (s.expiresAt <= now) m.delete(k);
  if (m.size === 0) byOrg.delete(orgId);
  return byOrg.get(orgId);
}

/**
 * Stage one TXT value. A name may carry several at once (a `*.acme.com` and an
 * `acme.com` order share `_acme-challenge.acme.com`). Re-staging refreshes the expiry.
 */
export function stageChallenge(
  orgId: string,
  c: { zone: string; relName: string; value: string },
  now = Date.now(),
): void {
  const m = prune(orgId, now) ?? new Map<string, Staged>();
  m.set(key(c.zone, c.relName, c.value), { ...c, expiresAt: now + CHALLENGE_TTL_MS });
  byOrg.set(orgId, m);
}

/** Withdraw one TXT value (idempotent). Returns whether it was staged. */
export function removeChallenge(
  orgId: string,
  c: { zone: string; relName: string; value: string },
  now = Date.now(),
): boolean {
  const m = prune(orgId, now);
  const had = m?.delete(key(c.zone, c.relName, c.value)) ?? false;
  if (m && m.size === 0) byOrg.delete(orgId);
  return had;
}

/** The live challenge TXT records for one zone (zone-relative names), sorted. */
export function challengeRecords(orgId: string, zone: string, now = Date.now()): StaticDnsRecord[] {
  const m = prune(orgId, now);
  if (!m) return [];
  return [...m.values()]
    .filter((s) => s.zone === zone)
    .sort((a, b) => (a.relName + a.value < b.relName + b.value ? -1 : 1))
    .map((s) => ({ name: s.relName, type: 'TXT' as const, value: s.value, ttl: CHALLENGE_RECORD_TTL }));
}

/** Test seam. */
export function _resetChallenges(): void {
  byOrg.clear();
}
