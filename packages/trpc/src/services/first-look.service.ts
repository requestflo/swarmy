/**
 * `deploys.firstLook` — the "It's live" stats, measured from the controller:
 * first response (time to first byte of an HTTPS GET), whether HTTPS is valid
 * and until when, and healthy copies. No site picture, no TLS grade (owner
 * decision Q1, 2026-09-26).
 *
 * SSRF safeguards (the probe itself is in ./first-look-probe):
 *   1. The host is only ever one of THIS org's routes on THIS stack (from the
 *      live `swarmy.ingress.routes` labels); any other host is refused before
 *      anything is dialled.
 *   2. The address dialled is one of the org's own swarmy edge IPs
 *      (`expectedTarget`), never the host's DNS answer — the host rides as SNI
 *      and Host only. No edge IP known (a tunnel, nothing reported) → no probe.
 *   3. Port 443, 5 s cap, at most one redirect and only to the same host.
 *   4. At most one probe per stack+host per 10 s (cached, in-flight shared).
 */
import { isIP } from 'node:net';
import { buildInventory, type FirstLookInput, type FirstLookView } from '@swarmy/core';
import type { OrgContext } from '../context';
import { badRequest, notFound } from '../errors';
import { expectedTarget } from './domain-verify.service';
import { listDomains, type DomainView } from './ingress.service';
import { httpsProbe, sameHostRedirect, type ProbeResult, type ProbeTarget } from './first-look-probe';

const TIMEOUT_MS = 5_000;
const CACHE_MS = 10_000;

export interface FirstLookDeps {
  listDomains: (ctx: OrgContext, stack: string) => Promise<DomainView[]>;
  edgeIps: (ctx: OrgContext) => Promise<string[]>;
  probe: (t: ProbeTarget) => Promise<ProbeResult>;
  now: () => number;
}

const defaults: FirstLookDeps = {
  listDomains: (ctx, stack) => listDomains(ctx, stack),
  edgeIps: async (ctx) => (await expectedTarget(ctx)).ips,
  probe: httpsProbe,
  now: () => Date.now(),
};

const cache = new Map<string, { at: number; view: Promise<FirstLookView> }>();

/** For tests: forget every cached look. */
export function resetFirstLookCache(): void {
  cache.clear();
}

const norm = (h: string): string => h.trim().toLowerCase().replace(/\.$/, '');

/** The route to look at: the one asked for (must be this stack's), else the primary HTTPS one. */
function pickRoute(routes: DomainView[], host: string | undefined, stack: string): DomainView | null {
  if (host) {
    const r = routes.find((d) => norm(d.host) === norm(host));
    if (!r) throw badRequest(`${host} isn't one of ${stack}'s addresses. swarmy only checks an app's own addresses.`);
    return r;
  }
  const https = routes.filter((d) => d.tls !== 'off');
  return https.find((d) => !d.auto) ?? https[0] ?? null;
}

/** GET via the edge, following at most one same-host redirect. */
async function measure(deps: FirstLookDeps, ip: string, host: string, path: string): Promise<ProbeResult> {
  const first = await deps.probe({ ip, host, path, timeoutMs: TIMEOUT_MS });
  if (!first.ok || first.status < 300 || first.status >= 400 || !first.location) return first;
  const next = sameHostRedirect(first.location, host, path);
  return next ? deps.probe({ ip, host, path: next, timeoutMs: TIMEOUT_MS }) : first;
}

function httpsOf(route: DomainView, probe: ProbeResult | null): FirstLookView['https'] {
  const cert = route.status?.certificate;
  if (cert && (cert.expiresAt || cert.error)) {
    const edgesOk = cert.edges.length === 0 || cert.edges.every((e) => e.ok);
    return { valid: !cert.error && edgesOk, validUntil: cert.expiresAt, source: 'edge-check', error: cert.error };
  }
  if (!probe?.tls) return null;
  const until = probe.tls.validTo ? new Date(probe.tls.validTo) : null;
  return {
    valid: probe.tls.authorized,
    validUntil: until && !Number.isNaN(until.getTime()) ? until.toISOString() : null,
    source: 'handshake',
    error: probe.tls.error,
  };
}

async function look(ctx: OrgContext, stack: string, route: DomainView | null, copies: FirstLookView['copies'], deps: FirstLookDeps): Promise<FirstLookView> {
  const base = { stack, host: route?.host ?? null, checkedAt: new Date(deps.now()).toISOString(), copies };
  if (!route) return { ...base, response: null, https: null };
  const ips = (await deps.edgeIps(ctx).catch(() => [] as string[])).filter((ip) => isIP(ip) !== 0);
  if (ips.length === 0) {
    return { ...base, response: { ok: false, error: 'swarmy doesn’t know an edge address to check it through yet' }, https: httpsOf(route, null) };
  }
  const probe = await measure(deps, ips[0]!, norm(route.host), route.pathPrefix || '/');
  const response: FirstLookView['response'] = probe.ok ? { ok: true, ms: probe.ttfbMs, status: probe.status } : { ok: false, error: probe.error };
  return { ...base, response, https: httpsOf(route, probe) };
}

/** `deploys.firstLook`: org-scoped, cached 10 s per stack + host. */
export async function firstLook(ctx: OrgContext, input: FirstLookInput, deps: FirstLookDeps = defaults): Promise<FirstLookView> {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const own = buildInventory(services, containers).services.filter((s) => s.stack === input.stack);
  if (own.length === 0) throw notFound('stack', input.stack);
  const copies = {
    running: own.reduce((n, s) => n + Math.min(s.replicas.running, s.replicas.desired), 0),
    desired: own.reduce((n, s) => n + s.replicas.desired, 0),
  };
  const route = pickRoute(await deps.listDomains(ctx, input.stack), input.host, input.stack);
  const key = `${ctx.activeOrgId}\0${input.stack}\0${route ? norm(route.host) : ''}`;
  const hit = cache.get(key);
  if (hit && deps.now() - hit.at < CACHE_MS) return { ...(await hit.view), copies };
  const view = look(ctx, input.stack, route, copies, deps);
  cache.set(key, { at: deps.now(), view });
  view.catch(() => cache.delete(key));
  return view;
}
