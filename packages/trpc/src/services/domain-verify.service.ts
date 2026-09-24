/**
 * Custom-domain verification + certificate status — the controller's IO shell
 * around the pure `@swarmy/ingress` domain-verify core.
 *
 * DNS: DNS-over-HTTPS from the controller to TWO public resolvers (Cloudflare
 * 1.1.1.1 and Google 8.8.8.8). Chosen over an agent one-shot because it needs
 * no protocol change, sees what the public (and Let's Encrypt) sees rather
 * than a node's split-horizon / systemd-resolved view, and bypasses the
 * controller container's own resolver cache. Both must agree before a host is
 * "verified", which is what turns propagation into an honest state.
 *
 * Certificates: a TLS handshake FROM the controller TO each edge's public IP
 * with SNI = the host. That is topology- and driver-independent (the shared
 * cert store is sealed client-side and the single-controller topology keeps
 * certs in a local volume, so neither is a uniform source), and it reports
 * what a visitor actually gets — per edge.
 *
 * The gate: a newly added auto-TLS host is withheld from the render (and
 * denied by `/ingress/ask`) until DNS points at us, so Let's Encrypt is never
 * asked for a name that cannot validate. See `@swarmy/ingress` domain-verify.
 */
import { connect as tlsConnect } from 'node:tls';
import {
  applyCheck,
  becameRenderable,
  certAlertFor,
  certFromProbes,
  companionHost,
  dnsGuidance,
  domainState,
  evaluateDns,
  isPrivateHost,
  lookupNameFor,
  mergeAnswers,
  newDomainRecord,
  normalizeHostname,
  parseDohJson,
  planDomainChecks,
  recordSignature,
  type CertObservation,
  type DnsGuidance,
  type DnsObservation,
  type DomainCheckRecord,
  type DomainChecks,
  type DomainState,
  type ExpectedTarget,
  type HostPosture,
  type ResolverAnswer,
  type TlsProbe,
  type WwwMode,
} from '@swarmy/ingress';
import type { OrgContext } from '../context';
import type { AgentHub } from '../hub/types';
import type { Auth } from '@swarmy/auth';
import type { DB } from '@swarmy/db';
import { notFound } from '../errors';
import { systemContext } from './cicd.service';
import { writeAudit } from './audit.service';
import { fireEvent } from './alerts-fire';
import { listRoutesForOrg, readRoutes, type Route } from './ingress-routes';
import { ingressTaskNodes } from './ingress-controller';
import { publicIpFromLabels } from './node.service';
import { dnsDb } from './dns-snapshot.service';
import {
  domainChecksOf,
  patchDomainChecks,
  readIngressSettingsRaw,
} from './domain-checks.store';

// ───────────────────────────────────────────── postures ──

type RouteTls = 'auto' | 'off' | 'manual';

/** The TLS mode a host renders with across all its routes (mirrors the renderer). */
function hostTls(tlss: RouteTls[]): HostPosture['tls'] {
  if (tlss.includes('manual')) return 'custom';
  if (tlss.length > 0 && tlss.every((t) => t === 'off')) return 'off';
  return 'auto';
}

function driverIsTunnel(driver: string | undefined): boolean {
  return (driver ?? '').toUpperCase() === 'CLOUDFLARE_TUNNEL';
}

/** Every host the org's routes make swarmy answer for (companions included). */
export function hostPostures(
  routes: ReadonlyArray<{ host: string; tls: RouteTls; www?: WwwMode }>,
  driver: string | undefined,
): HostPosture[] {
  const tlsByHost = new Map<string, RouteTls[]>();
  const add = (h: string, tls: RouteTls) => {
    const host = normalizeHostname(h);
    const list = tlsByHost.get(host);
    if (list) list.push(tls);
    else tlsByHost.set(host, [tls]);
  };
  for (const r of routes) {
    add(r.host, r.tls);
    if (r.www) {
      const c = companionHost(r.host);
      if (c) add(c, r.tls);
    }
  }
  const tunnel = driverIsTunnel(driver);
  return [...tlsByHost.entries()]
    .map(([host, tlss]) => ({ host, tls: hostTls(tlss), private: isPrivateHost(host), tunnel }))
    .sort((a, b) => (a.host < b.host ? -1 : 1));
}

async function orgDriver(ctx: OrgContext): Promise<string | undefined> {
  const row = await ctx.db.ingressConfig.findUnique({ where: { orgId: ctx.activeOrgId }, select: { driver: true } });
  return row?.driver;
}

function orgPostures(ctx: OrgContext, driver: string | undefined): HostPosture[] {
  return hostPostures(
    listRoutesForOrg(ctx).map((r) => r.route),
    driver,
  );
}

/**
 * Register hosts swarmy is about to start routing: every host (and toggled
 * companion) without a record gets one — GATED when it would need an ACME
 * order. Call BEFORE the route label lands, so the very first render already
 * withholds it. Existing records (incl. verified ones) are left alone.
 */
export async function registerDomainHosts(
  ctx: OrgContext,
  routes: ReadonlyArray<{ host: string; tls: RouteTls; www?: WwwMode }>,
  opts: { except?: ReadonlySet<string> } = {},
): Promise<void> {
  const driver = await orgDriver(ctx);
  const checks = domainChecksOf(await readIngressSettingsRaw(ctx));
  const now = Date.now();
  const upserts = hostPostures(routes, driver)
    .filter((p) => !p.private && !checks?.hosts[p.host] && !opts.except?.has(p.host))
    .map((p) => newDomainRecord(p, now));
  await patchDomainChecks(ctx, { upserts }).catch(() => undefined);
}

/**
 * PURE — the hosts (companions included) a deploy's specs would start routing
 * that no LIVE route serves today. Those are the ones a deploy must register
 * (gated) before the spec lands; a host already routed live is left to the
 * worker's "discovered, never withheld" path so a redeploy can never un-serve a
 * working site.
 */
export function hostsIntroducedByDeploy(
  specLabels: ReadonlyArray<Record<string, string> | undefined>,
  liveRoutes: ReadonlyArray<{ host: string; tls: RouteTls; www?: WwwMode }>,
): { routes: Route[]; liveHosts: Set<string> } {
  const liveHosts = new Set(hostPostures(liveRoutes, undefined).map((p) => p.host));
  const routes = specLabels.flatMap((l) => (l ? readRoutes(l) : []));
  const fresh = new Set(
    hostPostures(routes, undefined)
      .map((p) => p.host)
      .filter((h) => !liveHosts.has(h)),
  );
  return {
    routes: routes.filter((r) => fresh.has(normalizeHostname(r.host)) || (r.www && fresh.has(companionHost(r.host) ?? ''))),
    liveHosts,
  };
}

/**
 * The deploy-path domain gate: every deploy that writes specs (compose, a
 * single service, the builder) runs this BEFORE `service.deploy`, so a host a
 * compose file declares on `swarmy.ingress.routes` enters DNS verification
 * exactly like one added through `ingress.addDomain` — withheld from the render
 * (and `/ingress/ask`) until public DNS points at an edge. Hosts already routed
 * live are never gated (see {@link hostsIntroducedByDeploy}). Best-effort: a
 * failed registration never fails the deploy (the host is then merely
 * discovered, the pre-gate behaviour).
 */
export async function registerDeployRoutes(
  ctx: OrgContext,
  specs: ReadonlyArray<{ labels?: Record<string, string> }>,
): Promise<string[]> {
  const { routes, liveHosts } = hostsIntroducedByDeploy(
    specs.map((s) => s.labels),
    listRoutesForOrg(ctx).map((r) => r.route),
  );
  if (routes.length === 0) return [];
  await registerDomainHosts(ctx, routes, { except: liveHosts }).catch(() => undefined);
  return [...new Set(routes.map((r) => normalizeHostname(r.host)))];
}

/** Kick a first DNS check per host in the background (a host whose DNS already points here goes live in seconds). */
export function kickDomainChecks(ctx: OrgContext, hosts: readonly string[]): void {
  for (const host of hosts) void verifyDomainNow(ctx, host).catch(() => undefined);
}

// ───────────────────────────────────────────── expected target ──

/** Where public DNS should point for this org right now (edges' public IPs / tunnel). */
export async function expectedTarget(ctx: OrgContext): Promise<ExpectedTarget & { cnameTarget: string | null }> {
  const settings = await readIngressSettingsRaw(ctx);
  const driver = await orgDriver(ctx);
  const dashboard = typeof settings.dashboardDomain === 'string' ? settings.dashboardDomain : null;
  if (driverIsTunnel(driver)) {
    const t = settings.tunnel as { tunnelId?: string } | undefined;
    return { ips: [], tunnelCname: t?.tunnelId ? `${t.tunnelId}.cfargotunnel.com` : null, cnameTarget: null };
  }
  const ipOf = (id: string) => publicIpFromLabels(ctx.hub.nodeInfoFor(id)?.labels);
  const collect = (ids: string[]) => [...new Set(ids.map(ipOf).filter((ip): ip is string => Boolean(ip)))];
  // Caddy: exactly the nodes hosting a running edge task (host-mode 80/443).
  let ips = (driver ?? 'CADDY').toUpperCase() === 'CADDY' ? collect(await ingressTaskNodes(ctx).catch(() => [])) : [];
  if (ips.length === 0) {
    ips = collect(ctx.hub.nodesByRole(ctx.activeOrgId, 'ingress').filter((id) => ctx.hub.isOnline(id)));
  }
  if (ips.length === 0) {
    const nodes = await ctx.db.node.findMany({ where: { orgId: ctx.activeOrgId }, select: { id: true } });
    ips = collect(nodes.map((n) => n.id).filter((id) => ctx.hub.isOnline(id)));
  }
  // The dashboard's own domain already resolves to this edge — a CNAME target
  // that follows IP changes (only meaningful when swarmy's Caddy serves it).
  const cnameTarget = (driver ?? 'CADDY').toUpperCase() === 'CADDY' && dashboard ? dashboard : null;
  return { ips, tunnelCname: null, cnameTarget };
}

/** The swarmy-served (swarmy-ns) zone that contains `host`, if any. */
async function zoneFor(
  ctx: OrgContext,
  host: string,
): Promise<{ zone: string; nameservers: Array<{ fqdn: string; ip: string }> } | null> {
  const rows = await dnsDb(ctx)
    .dnsZone.findMany({ where: { orgId: ctx.activeOrgId, enabled: true } })
    .catch(() => []);
  const h = normalizeHostname(host).replace(/^\*\./, '');
  const match = rows
    .filter((z) => z.mode === 'swarmy-ns' && (h === z.zone || h.endsWith(`.${z.zone}`)))
    .sort((a, b) => b.zone.length - a.zone.length)[0];
  if (!match) return null;
  const ids = Array.isArray(match.advertisedNodeIds) ? (match.advertisedNodeIds as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  return {
    zone: match.zone,
    nameservers: ids.map((id, i) => ({
      fqdn: `ns${i + 1}.${match.zone}`,
      ip: publicIpFromLabels(ctx.hub.nodeInfoFor(id)?.labels) ?? '',
    })),
  };
}

// ───────────────────────────────────────────── IO: DoH + TLS ──

type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const RESOLVERS = [
  { name: '1.1.1.1', url: (n: string, t: string) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(n)}&type=${t}` },
  { name: '8.8.8.8', url: (n: string, t: string) => `https://dns.google/resolve?name=${encodeURIComponent(n)}&type=${t}` },
];

/** Resolve `name` (A + AAAA) on each public resolver over DNS-over-HTTPS. */
export async function dohLookup(name: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<ResolverAnswer[]> {
  return Promise.all(
    RESOLVERS.map(async (r) => {
      const parts = await Promise.all(
        ['A', 'AAAA'].map(async (type) => {
          try {
            const res = await fetchImpl(r.url(name, type), {
              headers: { accept: 'application/dns-json' },
              signal: AbortSignal.timeout(4000),
            });
            if (!res.ok) return { resolver: r.name, a: [], aaaa: [], cname: [], error: `HTTP ${res.status}` };
            return parseDohJson(await res.json(), r.name);
          } catch (e) {
            return { resolver: r.name, a: [], aaaa: [], cname: [], error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      return mergeAnswers(r.name, parts);
    }),
  );
}

/** One TLS handshake to `ip:443` with SNI `servername`; never throws. */
export function tlsProbe(ip: string, servername: string, timeoutMs = 5000): Promise<TlsProbe> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (p: TlsProbe) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {
        /* already closed */
      }
      resolve(p);
    };
    const sock = tlsConnect({ host: ip, port: 443, servername, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] });
    const timer = setTimeout(() => finish({ ip, error: 'timed out connecting to the edge on :443' }), timeoutMs);
    sock.once('secureConnect', () => {
      const cert = sock.getPeerCertificate();
      const issuer = (cert?.issuer ?? {}) as { O?: string; CN?: string };
      finish({
        ip,
        authorized: sock.authorized,
        authorizationError: sock.authorizationError ? String(sock.authorizationError) : null,
        issuerOrg: issuer.O ?? null,
        issuerCn: issuer.CN ?? null,
        validTo: cert?.valid_to ?? null,
        subjectAltName: cert?.subjectaltname ?? null,
      });
    });
    sock.once('error', (e: Error) => finish({ ip, error: e.message }));
  });
}

/** Probe every edge (or the host itself when no edge IP is known). */
async function probeCert(host: string, ips: string[]): Promise<CertObservation> {
  const sni = lookupNameFor(host);
  const targets = ips.length > 0 ? ips.slice(0, 8) : [sni];
  return certFromProbes(sni, await Promise.all(targets.map((ip) => tlsProbe(ip, sni))));
}

// ───────────────────────────────────────────── one check ──

/** Run one DNS (+ cert, once verified) check for a record. Pure fold via applyCheck. */
async function runCheck(
  rec: DomainCheckRecord,
  posture: HostPosture,
  expected: ExpectedTarget,
  now: number,
  io: { lookup?: typeof dohLookup; probe?: typeof probeCert } = {},
): Promise<DomainCheckRecord> {
  const lookup = io.lookup ?? dohLookup;
  const probe = io.probe ?? probeCert;
  const dns: DnsObservation = evaluateDns(rec.host, await lookup(lookupNameFor(rec.host)), expected);
  const verified = rec.verifiedAt !== undefined || dns.ok;
  const wantsCert = verified && posture.tls !== 'off' && !posture.tunnel;
  // A just-verified gated host isn't rendered yet — its cert is checked next tick.
  const justUngated = rec.verifiedAt === undefined && rec.gated;
  const cert = wantsCert && !justUngated ? await probe(rec.host, expected.ips) : undefined;
  return applyCheck(rec, { dns, cert }, now);
}

// ───────────────────────────────────────────── views ──

export interface DomainStatusView {
  host: string;
  state: DomainState;
  reason: string;
  warnings: string[];
  /** Withheld from the edge until DNS verifies (no certificate is requested). */
  gated: boolean;
  verifiedAt: string | null;
  verifiedManually: boolean;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  dns: { a: string[]; aaaa: string[]; cname: string[]; matched: string[] } | null;
  certificate: {
    issuer: string | null;
    expiresAt: string | null;
    error: string | null;
    edges: Array<{ ip: string; ok: boolean; error?: string }>;
    checkedAt: string | null;
  } | null;
}

export interface DomainDetailView extends DomainStatusView {
  /** Exactly what to create at the DNS provider. */
  guidance: DnsGuidance;
  /** The companion host added by a www toggle, with its own status. */
  companion: DomainStatusView | null;
}

const iso = (ms: number | undefined | null) => (typeof ms === 'number' ? new Date(ms).toISOString() : null);

/** Project a record + posture to the public status view. Pure. */
export function toStatusView(host: string, rec: DomainCheckRecord | undefined, posture: HostPosture, now: number): DomainStatusView {
  const s = domainState(rec, posture, now);
  return {
    host,
    state: s.state,
    reason: s.reason,
    warnings: s.warnings,
    gated: Boolean(rec?.gated && rec.verifiedAt === undefined),
    verifiedAt: iso(rec?.verifiedAt),
    verifiedManually: rec?.verifiedManually ?? false,
    lastCheckedAt: iso(rec?.lastCheckedAt),
    nextCheckAt: iso(rec?.nextCheckAt),
    dns: rec?.dns ? { a: rec.dns.a, aaaa: rec.dns.aaaa, cname: rec.dns.cname, matched: rec.dns.matched } : null,
    certificate: rec?.cert
      ? {
          issuer: rec.cert.issuer,
          expiresAt: iso(rec.cert.notAfter),
          error: rec.cert.error,
          edges: rec.cert.edges,
          checkedAt: iso(rec.certCheckedAt),
        }
      : null,
  };
}

/** Status views for every routed host, keyed by host (for listDomains). */
export async function domainStatusMap(ctx: OrgContext): Promise<Map<string, DomainStatusView>> {
  const driver = await orgDriver(ctx);
  const checks = domainChecksOf(await readIngressSettingsRaw(ctx));
  const now = Date.now();
  const out = new Map<string, DomainStatusView>();
  for (const p of orgPostures(ctx, driver)) out.set(p.host, toStatusView(p.host, checks?.hosts[p.host], p, now));
  return out;
}

function requirePosture(postures: HostPosture[], host: string): HostPosture {
  const p = postures.find((x) => x.host === host);
  if (!p) throw notFound('domain', host);
  return p;
}

/** Full status + DNS guidance for one routed host. */
export async function getDomainStatus(ctx: OrgContext, rawHost: string): Promise<DomainDetailView> {
  const host = normalizeHostname(rawHost);
  const driver = await orgDriver(ctx);
  const postures = orgPostures(ctx, driver);
  const posture = requirePosture(postures, host);
  const checks = domainChecksOf(await readIngressSettingsRaw(ctx));
  const expected = await expectedTarget(ctx);
  const zone = await zoneFor(ctx, host);
  const now = Date.now();
  const guidanceFor = (h: string, p: HostPosture) =>
    dnsGuidance({ host: h, expected, cnameTarget: expected.cnameTarget, zone, private: p.private });
  const route = listRoutesForOrg(ctx).find((r) => normalizeHostname(r.route.host) === host)?.route;
  const companion = route?.www ? companionHost(host) : null;
  const companionPosture = companion ? postures.find((p) => p.host === companion) : undefined;
  return {
    ...toStatusView(host, checks?.hosts[host], posture, now),
    guidance: guidanceFor(host, posture),
    companion:
      companion && companionPosture ? toStatusView(companion, checks?.hosts[companion], companionPosture, now) : null,
  };
}

// ───────────────────────────────────────────── mutations ──

/** Re-check one host (and its companion) right now; re-renders the edge on a flip. */
export async function verifyDomainNow(ctx: OrgContext, rawHost: string): Promise<DomainDetailView> {
  const host = normalizeHostname(rawHost);
  const driver = await orgDriver(ctx);
  const postures = orgPostures(ctx, driver);
  requirePosture(postures, host);
  const route = listRoutesForOrg(ctx).find((r) => normalizeHostname(r.route.host) === host)?.route;
  const hosts = [host, ...(route?.www ? [companionHost(host)].filter((h): h is string => Boolean(h)) : [])];
  await checkHosts(ctx, postures.filter((p) => hosts.includes(p.host) && !p.private));
  return getDomainStatus(ctx, host);
}

/**
 * Operator override: treat a host as verified without the DNS check — for a
 * domain fronted by an external load balancer / proxy whose IPs swarmy can't
 * know. Audited: this is the one path that can send an unverifiable name to
 * Let's Encrypt.
 */
export async function skipDomainVerification(ctx: OrgContext, rawHost: string): Promise<DomainDetailView> {
  const host = normalizeHostname(rawHost);
  const driver = await orgDriver(ctx);
  const posture = requirePosture(orgPostures(ctx, driver), host);
  const checks = domainChecksOf(await readIngressSettingsRaw(ctx));
  const now = Date.now();
  const rec = checks?.hosts[host] ?? newDomainRecord(posture, now);
  await patchDomainChecks(ctx, {
    upserts: [{ ...rec, verifiedAt: rec.verifiedAt ?? now, verifiedManually: true, nextCheckAt: now }],
  });
  await writeAudit(ctx, {
    action: 'ingress.skipDomainVerification',
    targetType: 'domain',
    targetId: host,
    metadata: { host },
  });
  await reapplyEdge(ctx);
  return getDomainStatus(ctx, host);
}

/** Re-render the edge so a newly verified host is served now (best-effort). */
async function reapplyEdge(ctx: OrgContext): Promise<void> {
  const { applyNow, getConfig } = await import('./ingress.service');
  const cfg = await getConfig(ctx).catch(() => null);
  if (cfg && cfg.enabled && cfg.driver !== 'none') await applyNow(ctx).catch(() => undefined);
}

/**
 * Check a set of hosts, persist changed records, re-render on a gate flip.
 * Returns how many hosts became renderable.
 */
async function checkHosts(
  ctx: OrgContext,
  postures: HostPosture[],
  opts: { checks?: DomainChecks; create?: DomainCheckRecord[]; now?: number } = {},
): Promise<number> {
  if (postures.length === 0) return 0;
  const now = opts.now ?? Date.now();
  const checks = opts.checks ?? domainChecksOf(await readIngressSettingsRaw(ctx));
  const created = new Map((opts.create ?? []).map((r) => [r.host, r]));
  const expected = await expectedTarget(ctx);
  let flips = 0;
  const upserts: DomainCheckRecord[] = [];
  // Small fan-out: at most 5 hosts in flight (each = 4 DoH requests + probes).
  for (let i = 0; i < postures.length; i += 5) {
    const batch = postures.slice(i, i + 5);
    const results = await Promise.all(
      batch.map(async (p) => {
        const before = checks?.hosts[p.host] ?? created.get(p.host) ?? newDomainRecord(p, now);
        const after = await runCheck(before, p, expected, now).catch(() => null);
        return { before, after };
      }),
    );
    for (const [i, { before, after }] of results.entries()) {
      if (!after) continue;
      // cert-expiry (default-on rule): expiring < 14d → warning (< 3d critical),
      // issuance/renewal failing → critical, valid again → resolved. Deduped by
      // (signal, resource) in fireEvent, so re-firing each check just refreshes.
      if (after.cert) {
        const alert = certAlertFor(after, batch[i]!, now);
        if (alert) {
          await fireEvent(ctx, {
            signal: 'cert-expiry',
            severity: alert.severity,
            resource: `domain:${after.host}`,
            message: alert.message,
            status: alert.status,
          }).catch(() => undefined);
        }
      }
      if (becameRenderable(before, after)) flips++;
      upserts.push(after);
      if (after.verifiedAt !== undefined && before.verifiedAt === undefined) {
        await writeAudit(ctx, {
          action: 'ingress.domainVerified',
          actorType: 'system',
          targetType: 'domain',
          targetId: after.host,
          metadata: { host: after.host, matched: after.dns?.matched ?? [] },
        }).catch(() => undefined);
      }
    }
  }
  await patchDomainChecks(ctx, { upserts });
  if (flips > 0) await reapplyEdge(ctx);
  return flips;
}

// ───────────────────────────────────────────── worker entry ──

export interface DomainCheckReconcileResult {
  checked: number;
  created: number;
  pruned: number;
  becameRenderable: number;
  /** Signature of the org's material domain state (unchanged ⇒ nothing new to show). */
  signature: string;
}

/**
 * One worker tick for one org: plan (pure) → check due hosts → persist →
 * re-render on a gate flip. Steady state: only hosts whose `nextCheckAt` has
 * passed are looked up (backoff lives in `nextCheckDelay`), and nothing is
 * dispatched unless a host became renderable.
 */
export async function reconcileDomainChecksOrg(
  deps: { db: DB; hub: AgentHub; auth: Auth },
  orgId: string,
  now = Date.now(),
): Promise<DomainCheckReconcileResult> {
  const ctx = systemContext(deps, orgId);
  const driver = await orgDriver(ctx);
  const postures = orgPostures(ctx, driver);
  const checks = domainChecksOf(await readIngressSettingsRaw(ctx));
  const plan = planDomainChecks({ hosts: postures, checks, now });
  if (plan.create.length > 0 || plan.prune.length > 0) {
    await patchDomainChecks(ctx, { upserts: plan.create, remove: plan.prune });
  }
  const due = postures.filter((p) => plan.check.includes(p.host));
  const flips = await checkHosts(ctx, due, { checks, create: plan.create, now });
  const after = domainChecksOf(await readIngressSettingsRaw(ctx));
  const signature = JSON.stringify(
    Object.values(after?.hosts ?? {})
      .sort((a, b) => (a.host < b.host ? -1 : 1))
      .map((r) => [r.host, recordSignature(r)]),
  );
  return { checked: due.length, created: plan.create.length, pruned: plan.prune.length, becameRenderable: flips, signature };
}
