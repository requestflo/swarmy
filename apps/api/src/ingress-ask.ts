/**
 * Caddy on-demand-TLS `ask` endpoint (ingress-strategy epic).
 *
 * Caddy calls this before issuing a certificate for a hostname it has never seen
 * (on-demand TLS). We answer 200 ONLY for hostnames that are a registered ingress
 * route for some org — deny-by-default. This is the standard mitigation against the
 * on-demand-TLS abuse vector (an attacker pointing arbitrary domains at the swarm
 * to exhaust ACME / Let's-Encrypt rate limits).
 *
 * Routes are Docker-truth: per-service routing lives on the `swarmy.ingress.routes`
 * service label, read from the live hub inventory (never the DB). The route is
 * public, unauthenticated, and read-only — Caddy nodes have no session, and the
 * endpoint has no org, so it scans every org's live inventory for a matching host.
 * It MUST be fast (Caddy enforces a short timeout), so a tiny in-process positive
 * cache short-circuits repeat handshakes. Per-request checks are intentionally NOT
 * audited (they are high-volume); only config changes elsewhere are.
 */
import type { ContainerInfo, SwarmServiceInfo } from '@swarmy/core/protocol';

/** The single Docker service label carrying a service's ingress routes (JSON array). */
const INGRESS_ROUTES_LABEL = 'swarmy.ingress.routes';

/** Short positive cache so repeated handshakes for a live host don't rescan. */
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
 * Dependencies for the on-demand check. Kept as a tiny injected surface (rather
 * than a concrete hub/db) so the matcher stays pure and trivially testable.
 */
export interface OnDemandDeps {
  /** Org ids whose live inventory should be scanned for a matching route host. */
  listOrgIds(): Promise<string[]>;
  /** Live Docker inventory for one org — services carry the `swarmy.ingress.routes` label. */
  liveInventory(orgId: string): { services: SwarmServiceInfo[]; containers: ContainerInfo[] };
}

/** Normalized route hosts declared on a service's `swarmy.ingress.routes` label. */
function routeHostsOf(labels: Record<string, string>): string[] {
  const raw = labels[INGRESS_ROUTES_LABEL];
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const hosts: string[] = [];
  for (const entry of parsed) {
    if (entry && typeof entry === 'object') {
      const host = (entry as { host?: unknown }).host;
      if (typeof host === 'string' && host.length > 0) hosts.push(normalizeHost(host));
    }
  }
  return hosts;
}

/**
 * Decide whether Caddy may issue a cert for `domain`. Pure-ish: takes the org list
 * + inventory reader so it is trivially testable (the host-match test calls this).
 */
export async function checkOnDemand(
  deps: OnDemandDeps,
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

  const orgIds = await deps.listOrgIds();
  for (const orgId of orgIds) {
    const { services } = deps.liveInventory(orgId);
    for (const svc of services) {
      if (routeHostsOf(svc.labels).includes(host)) {
        cache.set(host, now + POSITIVE_TTL_MS);
        return { status: 200, body: 'ok' };
      }
    }
  }
  return { status: 403, body: 'unknown domain' };
}

/** Test seam: clear the positive cache between cases. */
export function _resetAskCache(): void {
  cache.clear();
}
