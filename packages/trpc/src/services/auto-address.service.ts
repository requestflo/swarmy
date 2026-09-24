/**
 * Automatic app addresses — the controller shell around the pure
 * `@swarmy/ingress` auto-address planner. See that module for the naming,
 * eligibility and collision rules.
 *
 * Two entry points:
 *   - `autoAddressFor(ctx, stack, serviceName)` — the hostname a service WILL
 *     get, at plan time (blueprints/templates need it for env like
 *     NEXTAUTH_URL). Stamp it with `autoAddressLabels(...)` in the deploy to
 *     claim it up front; the worker then leaves it alone.
 *   - `reconcileAutoAddressesOrg(ctx)` — the worker step that stamps a route
 *     on every qualifying service that has none (first deploy), and re-hosts
 *     stamped routes when the edge IP changes.
 */
import {
  AUTO_ADDRESS_HOST_LABEL,
  autoLabelFor,
  planAutoAddresses,
  sslipBaseFor,
  type AutoAddressAction,
  type AutoAddressCandidate,
} from '@swarmy/ingress';
import { buildInventory } from '@swarmy/core';
import type { OrgContext } from '../context';
import type { AgentHub } from '../hub/types';
import type { Auth } from '@swarmy/auth';
import type { DB } from '@swarmy/db';
import { systemContext } from './cicd.service';
import { writeAudit } from './audit.service';
import { expectedTarget, kickDomainChecks, registerDomainHosts } from './domain-verify.service';
import { dnsDb } from './dns-snapshot.service';
import { isAutoAddressZone } from './dns-zones.service';
import { readIngressSettingsRaw } from './domain-checks.store';
import { INGRESS_ROUTES_LABEL, listRoutesForOrg, readRoutes, serializeRoutes, type Route } from './ingress-routes';

const INGRESS_ENABLED_LABEL = 'swarmy.ingress';

/**
 * The org's automatic-address zone: a swarmy-ns zone flagged with
 * `geodns.setZoneAutoAddresses` (which required live delegation), or null.
 */
export async function autoAddressZone(ctx: OrgContext): Promise<string | null> {
  const rows = await dnsDb(ctx)
    .dnsZone.findMany({ where: { orgId: ctx.activeOrgId, enabled: true, mode: 'swarmy-ns' }, orderBy: { zone: 'asc' } })
    .catch(() => []);
  return rows.find((r) => isAutoAddressZone(r.settings))?.zone ?? null;
}

/**
 * The base this org's apps get addresses under: the org's OWN zone served by
 * swarmy-dns when one is delegated and flagged (`<label>.<zone>` — no third
 * party in the path), else the sslip.io fallback `<label>.<edge-ip>.sslip.io`.
 * Null when neither can be formed (no edge IP yet, or behind a tunnel).
 */
export async function autoAddressBase(ctx: OrgContext): Promise<string | null> {
  const settings = await readIngressSettingsRaw(ctx);
  const expected = await expectedTarget(ctx);
  if (expected.tunnelCname) return null; // behind a tunnel there is no public edge IP to embed
  const zone = await autoAddressZone(ctx);
  if (zone) return zone;
  return sslipBaseFor({
    dashboardDomain: typeof settings.dashboardDomain === 'string' ? settings.dashboardDomain : null,
    edgeIps: expected.ips,
  });
}

/**
 * The automatic address a service gets: `<service>-<stack>.<edge-ip>.sslip.io`.
 * `serviceName` may be the full swarm name (`shop_web`) or the compose key
 * (`web`). Null when no edge IP is known (or the org runs behind a tunnel).
 */
export async function autoAddressFor(ctx: OrgContext, stack: string | null, serviceName: string): Promise<string | null> {
  const base = await autoAddressBase(ctx);
  return base ? `${autoLabelFor(stack, serviceName)}.${base}` : null;
}

/**
 * The service labels that claim `host` as a service's auto address — merge
 * into the service spec at deploy time. `existing` = the service's current
 * routes (the auto route is appended unless the host is already routed).
 */
export function autoAddressLabels(host: string, port: number, existing: Route[] = []): Record<string, string> {
  const routes = existing.some((r) => r.host === host) ? existing : [...existing, { host, port, tls: 'auto' as const }];
  return {
    [INGRESS_ROUTES_LABEL]: serializeRoutes(routes),
    [INGRESS_ENABLED_LABEL]: 'true',
    [AUTO_ADDRESS_HOST_LABEL]: host,
  };
}

/** Recently stamped (serviceId → at ms): the inventory lags the label write by a tick. */
const recentlyStamped = new Map<string, number>();
const STAMP_SETTLE_MS = 60_000;

/**
 * Converge auto addresses for one org (worker step). Only with swarmy's own
 * Caddy edge enabled. Signature-free by design: the plan is empty at steady
 * state (every stamped service carries the marker label).
 */
export async function reconcileAutoAddressesOrg(ctx: OrgContext, now = Date.now()): Promise<AutoAddressAction[]> {
  const row = await ctx.db.ingressConfig.findUnique({
    where: { orgId: ctx.activeOrgId },
    select: { driver: true, enabled: true },
  });
  if (!row || !row.enabled || row.driver !== 'CADDY') return [];
  const manager = ctx.hub.managerNode(ctx.activeOrgId);
  if (!manager) return [];
  const base = await autoAddressBase(ctx);
  if (!base) return [];
  // sslip.io names embed the edge IP (correct by construction — observed, never
  // gated). A name in the org's own zone resolves only once swarmy-dns has the
  // derived record: register it through the DNS gate so Caddy orders its
  // certificate after the name verifiably points at the edge, not before.
  const ownZone = !/\.(sslip|nip)\.io$/.test(base);

  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const inv = buildInventory(services, containers).services;
  const exposedBySvc = new Map<string, number[]>();
  for (const c of containers) {
    const sid = c.serviceId ?? c.labels?.['com.docker.swarm.service.id'];
    if (!sid) continue;
    const list = exposedBySvc.get(sid) ?? [];
    for (const p of c.ports) if (p.protocol === 'tcp') list.push(p.privatePort);
    exposedBySvc.set(sid, list);
  }
  const candidates: AutoAddressCandidate[] = inv
    .filter((s) => !s.regionParent) // region siblings ride their parent's route
    .map((s) => ({
      serviceId: s.id,
      serviceName: s.name,
      stack: s.stack,
      labels: s.labels,
      ports: s.ports,
      exposedTcp: exposedBySvc.get(s.id) ?? [],
      routeHosts: readRoutes(s.labels).map((r) => r.host),
    }));
  const takenHosts = listRoutesForOrg(ctx).map((r) => r.route.host);
  const actions = planAutoAddresses({ candidates, base, takenHosts }).filter(
    (a) => now - (recentlyStamped.get(a.serviceId) ?? 0) > STAMP_SETTLE_MS,
  );

  for (const a of actions) {
    const svc = inv.find((s) => s.id === a.serviceId);
    if (!svc) continue;
    const current = readRoutes(svc.labels);
    const add =
      a.kind === 'add'
        ? autoAddressLabels(a.host, a.port, current)
        : autoAddressLabels(
            a.host,
            0,
            current.map((r) => (r.host === a.previousHost ? { ...r, host: a.host } : r)),
          );
    try {
      if (ownZone) await registerDomainHosts(ctx, [{ host: a.host, tls: 'auto' }]);
      await ctx.hub.dispatch(manager, 'service.updateLabels', { service: svc.name, add, removeKeys: [] });
      if (ownZone) kickDomainChecks(ctx, [a.host]);
      recentlyStamped.set(a.serviceId, now);
      await writeAudit(ctx, {
        action: a.kind === 'add' ? 'ingress.autoAddress' : 'ingress.autoAddressRehost',
        actorType: 'system',
        targetType: 'service',
        targetId: svc.name,
        metadata: a.kind === 'add' ? { host: a.host, port: a.port } : { host: a.host, previousHost: a.previousHost },
      }).catch(() => undefined);
    } catch {
      // Next tick retries; one service's failure never blocks the rest.
    }
  }
  return actions;
}

/** Worker entry: {@link reconcileAutoAddressesOrg} under the SYSTEM actor. */
export async function reconcileAutoAddressesForOrg(
  deps: { db: DB; hub: AgentHub; auth: Auth },
  orgId: string,
): Promise<AutoAddressAction[]> {
  return reconcileAutoAddressesOrg(systemContext(deps, orgId));
}
