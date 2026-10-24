/**
 * Personal mesh grants can carry a TTL (`MeshRoute.expiresAt`, people access
 * plans/epic-self-hosted-mesh-and-fleets.md §3.2). This is the pure half of
 * the TTL sweeper: which grants are past their time. The `mesh-grant-ttl`
 * worker (apps/api) revokes each one through the same path as a person
 * pressing Revoke, as the system actor, then converges NetBird once.
 *
 * Expiry is inclusive: a grant is gone from the instant `expiresAt` passes,
 * the same rule the people plan uses when it leaves expired grants out.
 */

export interface ExpiringGrant {
  id: string;
  /** No expiry = never lapses. */
  expiresAt: Date | string | null;
}

function expiryMs(g: ExpiringGrant): number | null {
  if (g.expiresAt === null) return null;
  const ms = g.expiresAt instanceof Date ? g.expiresAt.getTime() : Date.parse(g.expiresAt);
  // A malformed timestamp never revokes anything: losing access on garbage is worse than keeping it a tick.
  return Number.isFinite(ms) ? ms : null;
}

export function isGrantExpired(g: ExpiringGrant, now: Date): boolean {
  const ms = expiryMs(g);
  return ms !== null && ms <= now.getTime();
}

export interface GrantSweepPlan<T extends ExpiringGrant> {
  /** Grants to revoke now, oldest expiry first (then id), so runs are deterministic. */
  expired: T[];
  /** How many still have time left (with or without an expiry). */
  kept: number;
  /** The next expiry still to come, if any (for the log line). */
  nextExpiry: Date | null;
}

export function planGrantSweep<T extends ExpiringGrant>(grants: readonly T[], now: Date): GrantSweepPlan<T> {
  const expired: { g: T; ms: number }[] = [];
  let next: number | null = null;
  for (const g of grants) {
    const ms = expiryMs(g);
    if (ms !== null && ms <= now.getTime()) expired.push({ g, ms });
    else if (ms !== null && (next === null || ms < next)) next = ms;
  }
  expired.sort((a, b) => a.ms - b.ms || (a.g.id < b.g.id ? -1 : a.g.id > b.g.id ? 1 : 0));
  return {
    expired: expired.map((e) => e.g),
    kept: grants.length - expired.length,
    nextExpiry: next === null ? null : new Date(next),
  };
}
