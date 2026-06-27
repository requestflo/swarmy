/**
 * Caddy on-demand-TLS `ask` endpoint (ingress-strategy epic).
 *
 * Caddy calls this before issuing a certificate for a hostname it has never seen
 * (on-demand TLS). We answer 200 ONLY for hostnames that are registered Domains
 * for some org — deny-by-default. This is the standard mitigation against the
 * on-demand-TLS abuse vector (an attacker pointing arbitrary domains at the
 * swarm to exhaust ACME / Let's-Encrypt rate limits).
 *
 * The route is public, unauthenticated, and read-only — Caddy nodes have no
 * session. It MUST be fast (Caddy enforces a short timeout), so it is a single
 * indexed `Domain.host` lookup with a tiny in-process positive cache. Per-request
 * checks are intentionally NOT audited (they are high-volume); only config
 * changes elsewhere are.
 */
import type { PrismaClient } from '@swarmy/db';

/** Short positive cache so repeated handshakes for a live host don't hit the DB. */
const POSITIVE_TTL_MS = 30_000;
const cache = new Map<string, number>();

/** Normalize a hostname for matching (lowercase, strip trailing dot/port). */
export function normalizeHost(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/:\d+$/, '');
}

export interface AskResult {
  status: 200 | 400 | 403;
  body: string;
}

/**
 * Decide whether Caddy may issue a cert for `domain`. Pure-ish: takes the db
 * client so it is trivially testable (the domain-match test calls this).
 */
export async function checkOnDemand(
  db: Pick<PrismaClient, 'domain'>,
  rawDomain: string | undefined | null,
): Promise<AskResult> {
  if (!rawDomain) return { status: 400, body: 'missing domain' };
  const host = normalizeHost(rawDomain);
  if (!host || host.includes('/') || host.includes(' ')) {
    return { status: 400, body: 'invalid domain' };
  }

  const now = Date.now();
  const cached = cache.get(host);
  if (cached && cached > now) return { status: 200, body: 'ok' };

  const match = await db.domain.findFirst({ where: { host }, select: { id: true } });
  if (match) {
    cache.set(host, now + POSITIVE_TTL_MS);
    return { status: 200, body: 'ok' };
  }
  return { status: 403, body: 'unknown domain' };
}

/** Test seam: clear the positive cache between cases. */
export function _resetAskCache(): void {
  cache.clear();
}
