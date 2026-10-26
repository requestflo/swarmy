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
 *
 * Custom-domain DNS gate: a host that is routed but whose DNS has not yet been
 * verified to point at a swarmy edge is DENIED too (`isGated`), so a freshly
 * added domain never triggers an ACME order that cannot validate. A www
 * companion added by a route's apex↔www toggle counts as a route host.
 *
 * Every answer with a host also says why and for which org (`why`, `orgId`,
 * `app`), which the route records in the bounded in-memory ask log
 * (`@swarmy/trpc` `recordAskDecision`) that Edge settings shows. A host
 * nobody routes is attributed to the controller's only org, else to none.
 */
import type { ContainerInfo, SwarmServiceInfo } from '@swarmy/core/protocol';
import type { AskWhy } from '@swarmy/trpc';
import { domainChecksOf, hostsWithCompanions, isHostGated, WWW_MODES, type WwwMode } from '@swarmy/ingress';

/** The single Docker service label carrying a service's ingress routes (JSON array). */
const INGRESS_ROUTES_LABEL = 'swarmy.ingress.routes';

/** Short positive cache so repeated handshakes for a live host don't rescan. */
const POSITIVE_TTL_MS = 30_000;
const cache = new Map<string, { until: number; orgId: string; app: string | null }>();

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
  /** The host asked about, normalised (absent when none was sent). */
  host?: string;
  why?: AskWhy;
  /** The org it was answered for; null = no org's. */
  orgId?: string | null;
  /** The app (stack) routing it, when allowed or waiting on DNS. */
  app?: string | null;
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
  /** Is `host` still waiting for DNS verification in this org? (absent = never gated) */
  isGated?(orgId: string, host: string): Promise<boolean>;
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
  const entries: Array<{ host: string; www?: WwwMode }> = [];
  for (const entry of parsed) {
    if (entry && typeof entry === 'object') {
      const { host, www } = entry as { host?: unknown; www?: unknown };
      if (typeof host === 'string' && host.length > 0) {
        entries.push({
          host: normalizeHost(host),
          www: typeof www === 'string' && (WWW_MODES as readonly string[]).includes(www) ? (www as WwwMode) : undefined,
        });
      }
    }
  }
  return hostsWithCompanions(entries);
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
  const valid = !!host && !host.includes('/') && !host.includes(' ');

  const now = Date.now();
  const cached = valid ? cache.get(host) : undefined;
  if (cached && cached.until > now) return { status: 200, body: 'ok', host, why: 'routed', orgId: cached.orgId, app: cached.app };

  const orgIds = await deps.listOrgIds();
  // A host nobody routes can only be attributed when the controller serves one org.
  const onlyOrg = orgIds.length === 1 ? orgIds[0]! : null;
  if (!valid) return { status: 400, body: 'invalid domain', host: host.slice(0, 253), why: 'invalid', orgId: onlyOrg };

  for (const orgId of orgIds) {
    const { services } = deps.liveInventory(orgId);
    for (const svc of services) {
      if (routeHostsOf(svc.labels).includes(host)) {
        const app = svc.labels['com.docker.stack.namespace'] ?? null;
        if (deps.isGated && (await deps.isGated(orgId, host).catch(() => true))) {
          return { status: 403, body: 'domain awaiting DNS verification', host, why: 'dns-pending', orgId, app };
        }
        cache.set(host, { until: now + POSITIVE_TTL_MS, orgId, app });
        return { status: 200, body: 'ok', host, why: 'routed', orgId, app };
      }
    }
  }
  return { status: 403, body: 'unknown domain', host, why: 'unknown', orgId: onlyOrg };
}

/**
 * The production `isGated` dep: reads the org's persisted domain checks
 * (`settings.domainChecks` on the org's swarm-kv ingress document, via
 * `readSettings`) and applies the shared gate rule.
 */
export function makeIsGated(
  readSettings: (orgId: string) => Promise<Record<string, unknown>>,
): (orgId: string, host: string) => Promise<boolean> {
  return async (orgId, host) => isHostGated(domainChecksOf(await readSettings(orgId)), host);
}

/** Test seam: clear the positive cache between cases. */
export function _resetAskCache(): void {
  cache.clear();
}
