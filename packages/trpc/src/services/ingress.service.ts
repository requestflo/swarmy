import {
  CADDY_CONTROLLER_SERVICE,
  CADDY_EDGE_SERVICE,
  companionHost,
  expandWww,
  isHostGated,
  normalizeHostname,
  applyIngress as applyIngressPkg,
  previewConfig as previewConfigPkg,
  resolveEdgeGeoip,
  tunnelSideConfig,
  type ColdRoute,
  type ControllerVhost,
  type DriverDispatch,
  type IngressConfig as OrgIngressConfig,
  type RouteProtection,
  type TunnelOptions,
  type WwwMode,
  appAuthVerifyPath,
  redactRenderedSecrets,
} from '@swarmy/ingress';
import type { IngressStatus, RenderedConfig } from '@swarmy/core/protocol';
import { meshControlVhosts } from './mesh-control.service';
import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { buildInventory, type ExposeMode, type TlsMode } from '@swarmy/core';
import { decryptSecret } from '@swarmy/core/crypto';
import { wakePathFor } from '@swarmy/core/wake-token';
import type { Auth } from '@swarmy/auth';
import type { DB } from '@swarmy/db';
import type { AgentHub } from '../hub/types';
import type { OrgContext } from '../context';
import { systemContext } from './cicd.service';
import { writeAudit } from '../services/audit.service';
import {
  defaultEdgeImage,
  deriveEdgeRuntime,
  ensureCaddyController,
  ensureCaddyEdge,
  ingressTaskNodes,
  ingressTasks,
  type EdgeApplyRecord,
  type EdgeRuntimeStatus,
} from './ingress-controller';
import { commandRejected, notFound } from '../errors';
import { resolveManagerNode } from './dispatch.service';
import { resolveLiveService } from './live-resolve';
import { listOutlets as listAiOutlets } from './ai.service';
import {
  INGRESS_ROUTES_LABEL,
  listRoutesForOrg,
  readRoutes,
  serializeRoutes,
  type Route,
} from './ingress-routes';
import { regionUpstreamsFor } from './ingress-regions';
import { rumRouteResolver } from './rum/rum-settings.service';
import { basicAuthResolver } from './ingress-basic-auth';
import { attachRoutedServicesToEdge, servicesMissingEdge } from './ingress-network';
import { publicIpFromLabels } from './node.service';
import { objectStoreState } from './buckets.service';
import { objectStorageEdgeFor } from './bucket-access.service';
import {
  certStorageFor,
  ensureEdgeCertStorage,
  purgeLegacyEdgeCerts,
  type EdgeCertStorageSettings,
} from './ingress-certs';
import { domainChecksOf } from './domain-checks.store';
import { edgeGeoipInputs } from './edge-geoip.service';
import { wildcardBaseFrom } from './auto-address-base.service';
import { clusterZoneName } from './cluster-zone';
import { ingressConfigRepo, type IngressDriverEnum } from './ingress-config.repo';
import { observabilityConfigRepo } from './observability-config.repo';
import { meshPeers } from './mesh-peers';
import { domainStatusMap, registerDomainHosts, type DomainStatusView } from './domain-verify.service';
import { edgeAcmeDnsSecrets, orgDnsChallenge, readAcmeDnsSettings, requiredAcmeDnsSecrets } from './acme-dns.service';

/** Service label that marks a Docker service as ingress-enabled (replaces the dropped column). */
const INGRESS_ENABLED_LABEL = 'swarmy.ingress';

/** Swarm node-role label that marks a node as an ingress (edge) node. */
const INGRESS_NODE_LABEL = 'swarmy.node.ingress';

/**
 * Org nodes (enrollment ids) explicitly marked as ingress nodes via the swarm
 * label `swarmy.node.ingress=true` and currently online. Membership/identity is
 * the DB's job; the role label + online state are Docker-truth read off the hub.
 */
async function ingressTargetNodes(ctx: OrgContext): Promise<string[]> {
  const nodes = await ctx.db.node.findMany({
    where: { orgId: ctx.activeOrgId },
    select: { id: true },
  });
  return nodes
    .filter(
      (n) =>
        ctx.hub.isOnline(n.id) &&
        ctx.hub.nodeInfoFor(n.id)?.labels[INGRESS_NODE_LABEL] === 'true',
    )
    .map((n) => n.id);
}

/**
 * TLS mode mapping between the route label and the render/DomainView layer. The
 * label scheme uses `'manual'` for an operator-supplied cert; the render layer
 * (and {@link TlsMode}) calls the same thing `'custom'`. `'auto'`/`'off'` pass through.
 */
function routeTlsToTlsMode(tls: Route['tls']): TlsMode {
  return tls === 'manual' ? 'custom' : tls;
}
function tlsModeToRouteTls(tls: TlsMode): Route['tls'] {
  return tls === 'custom' ? 'manual' : tls;
}

/**
 * Scale-to-zero activator base URL. Ingress routes a COLD (0-replica) domain here
 * so the controller can wake the service and 307 the caller back. Defaults to the
 * controller on the shared `swarmy` overlay — the same upstream the dashboard
 * vhost uses, which every edge (both topologies) can reach. The old default,
 * `host.docker.internal`, only resolves on Docker Desktop, so on every Linux
 * install a cold route 502'd instead of waking. A controller running on the host
 * (dev) sets SWARMY_ACTIVATOR_URL=http://host.docker.internal:3021.
 */
function activatorBaseUrl(): string {
  return process.env.SWARMY_ACTIVATOR_URL || `http://${dashboardUpstream()}`;
}

/** Activator dial target `host:port` (path stripped — the wake path is per-service). */
function activatorUpstream(): string {
  try {
    return new URL(activatorBaseUrl()).host;
  } catch {
    return dashboardUpstream();
  }
}

/**
 * Map of service name → COLD route for every scale-to-zero service that is asleep
 * (0 running replicas) in the org's live Docker inventory. A domain backed by a
 * name in this map renders an activator upstream instead of a direct one. Reading
 * `running === 0` (rather than `desired === 0`) keeps the domain pinned to the
 * activator through the wake transient — while the service scales up but no task is
 * live yet — so the bounce-back never lands on a 0-task service and 502s.
 */
export function computeColdRoutes(ctx: Pick<OrgContext, 'activeOrgId' | 'hub'>): Map<string, ColdRoute> {
  const cold = new Map<string, ColdRoute>();
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const upstream = activatorUpstream();
  for (const s of buildInventory(services, containers).services) {
    if (s.scaleToZero && s.replicas.running === 0) {
      // Signed per org + service: the activator wakes nothing without it.
      cold.set(s.name, { upstream, wakePath: wakePathFor(ctx.activeOrgId, s.name) });
    }
  }
  return cold;
}

/**
 * Driver ids supported at the controller. `cloudflared` is the Cloudflare Tunnel
 * (no-public-IP) driver added by the ingress-strategy epic.
 */
export type IngressDriverId = 'caddy' | 'none' | 'cloudflared';

/** Map a controller driver id ⇄ Prisma `IngressDriver` enum value. */
export const DRIVER_TO_ENUM: Record<IngressDriverId, IngressDriverEnum> = {
  caddy: 'CADDY',
  none: 'NONE',
  cloudflared: 'CLOUDFLARE_TUNNEL',
};

export interface IngressConfigView {
  driver: IngressDriverId;
  enabled: boolean;
  targetNodes: string[];
  domainCount: number;
  /**
   * Where the edge keeps its certificates. `shared` = every edge-per-node Caddy
   * uses ONE store in swarmy object storage (bucket `swarmy-edge-certs`);
   * `local` = Caddy's own data volume (the single-controller default, or
   * edge-per-node before object storage is on). Credentials are never returned.
   */
  certStorage: EdgeCertStorageView;
  /** Whether a Cloudflare tunnel is configured (secrets never returned). */
  tunnelConfigured: boolean;
  /** Custom ingress-controller image (null = {@link IngressConfigView.defaultControllerImage}). */
  controllerImage: string | null;
  /** The image deployed when no custom one is set (swarmy's Caddy build unless overridden by env). */
  defaultControllerImage: string;
  /** Edge topology: replicated controller vs global per-node edge (geo-edge). */
  topology: 'controller' | 'edge-per-node';
  /**
   * The controller's own https dashboard domain (self-host installer), when this
   * org's edge serves it. Null otherwise.
   */
  dashboardDomain?: string | null;
  /**
   * Operator-facing warning when the dashboard domain is configured but the
   * org's driver can't serve it (it needs swarmy's Caddy). Null when fine.
   */
  dashboardWarning?: string | null;
  updatedAt: string;
  /**
   * RUNTIME truth — is a swarmy-run proxy actually up and carrying the current
   * config? Derived from live Docker state + the last apply outcome, never from
   * `driver`/`enabled` alone. Status badges must read this, not the config.
   */
  runtime: EdgeRuntimeStatus;
}

export interface EdgeCertStorageView {
  mode: 'shared' | 'local';
  /** Running Caddy edges drawing on the store (0 while none are up). */
  edges: number;
  /** swarmy object storage (Garage) is on — edge-per-node requires it. */
  objectStorageEnabled: boolean;
  /** Bucket holding the shared pool (null when local). */
  bucket: string | null;
  /** Objects are sealed client-side before they reach the store (and its offsite mirror). */
  encrypted: boolean;
}

export interface DomainView {
  id: string;
  host: string;
  serviceId: string;
  serviceName: string;
  /** Docker stack the owning service belongs to (UNGROUPED when standalone). */
  stack: string;
  targetPort: number;
  tls: TlsMode;
  pathPrefix: string | null;
  /** Per-domain driver override (null = inherit org default). */
  ingressDriver: IngressDriverId | null;
  /** Edge protections carried on the route label (null = none). */
  protection: RouteProtection | null;
  /** Live canary traffic share (null = no canary in flight). */
  canaryPct: number | null;
  /**
   * Whether this route is actually being served right now (the org edge's
   * runtime state is `serving`). A configured-but-not-served route must not
   * render as live/secured.
   */
  serving: boolean;
  /** The org edge's runtime state this route rides on (see `IngressConfigView.runtime`). */
  edgeState: EdgeRuntimeStatus['state'];
  /** Apex ↔ www toggle on this route (null = only `host` is served). */
  www: WwwMode | null;
  /** The companion host the toggle adds (`www.<host>` / the bare apex), or null. */
  companionHost: string | null;
  /**
   * Custom-domain lifecycle: waiting_dns → verified → issuing → active | error,
   * with the reason in plain words. Null only while the status could not be read.
   */
  status: DomainStatusView | null;
  /** The companion host's own status (it needs its own DNS record + certificate). */
  companionStatus: DomainStatusView | null;
  /**
   * swarmy's automatic `<service>-<stack>.<edge-ip>.sslip.io` address (stamped on
   * first deploy). Removing it is permanent; adding a custom domain replaces it.
   */
  auto: boolean;
  /**
   * The owning service's declared exposure (`swarmy.expose`), which wins over
   * `ingressDriver` (see `routeChannel`); null = undeclared. Listed routes only.
   */
  expose?: ExposeMode | null;
}

/**
 * The DomainView id: `${serviceId}:${host}` for a root route, with the path
 * appended (`${serviceId}:${host}/api`) for a path route so every route of a
 * multi-path host has its own handle. Hosts never contain `/`, so it parses back.
 */
export function domainId(serviceId: string, host: string, path?: string | null): string {
  return path && path !== '/' ? `${serviceId}:${host}${path}` : `${serviceId}:${host}`;
}

/** Inverse of {@link domainId}. `path` is null for a root route. */
export function parseDomainId(id: string): { serviceId: string; host: string; path: string | null } {
  const sep = id.indexOf(':');
  const serviceId = sep >= 0 ? id.slice(0, sep) : id;
  const rest = sep >= 0 ? id.slice(sep + 1) : '';
  const slash = rest.indexOf('/');
  return slash >= 0
    ? { serviceId, host: rest.slice(0, slash), path: rest.slice(slash) }
    : { serviceId, host: rest, path: null };
}

/** Same route identity the label writers use: host + path (root = no path). */
function sameRoute(r: Route, host: string, path: string | null | undefined): boolean {
  const p = r.path && r.path !== '/' ? r.path : null;
  const q = path && path !== '/' ? path : null;
  return r.host === host && p === q;
}

interface ConfigRow {
  driver: string;
  enabled: boolean;
  settings: unknown;
  updatedAt: Date;
}

export function driverLower(d: string): IngressDriverId {
  switch (d.toUpperCase()) {
    case 'CADDY':
      return 'caddy';
    case 'CLOUDFLARE_TUNNEL':
      return 'cloudflared';
    default:
      return 'none';
  }
}

/**
 * Shape persisted in `IngressConfig.settings` (Json). Secret fields hold encrypted
 * vault blobs — never plaintext. They are decrypted just-in-time when building the
 * driver config for render/dispatch and are NEVER returned to the client.
 */
export interface IngressSettings {
  targetNodes?: string[];
  /**
   * The self-host dashboard domain this org's edge serves, recorded by the
   * bootstrap seed (apps/api/src/bootstrap/seed.ts) from SWARMY_DASHBOARD_DOMAIN
   * on every boot. It only binds the domain to THIS org; the env stays the
   * authority (see {@link dashboardDomainFor}).
   */
  dashboardDomain?: string;
  /**
   * Edge topology (geo-edge): 'controller' (default) = one replicated Caddy on
   * the routing mesh; 'edge-per-node' = a GLOBAL host-mode Caddy per ingress
   * node with per-node region-aware configs applied via the agent's localReload
   * path. Switching to edge-per-node cuts the legacy controller over (seconds
   * of blip) — explicit opt-in only.
   */
  topology?: 'controller' | 'edge-per-node';
  globalOptions?: Record<string, unknown>;
  /**
   * Caddy image both topologies deploy. Unset = {@link defaultEdgeImage}
   * (swarmy's Caddy build, `ghcr.io/requestflo/caddy-swarmy:latest`, which
   * carries every plugin the renderer can emit).
   */
  controllerImage?: string;
  /**
   * Shared cert store for edge-per-node (swarmy object storage). Non-secret
   * coordinates only — the credentials live solely in the Docker secret it
   * names. Kept across a switch back to `controller` (that topology renders
   * local file storage), so returning to edge-per-node reuses the pool.
   * (Legacy `haStorage` Redis settings from older builds are ignored.)
   */
  certStorage?: EdgeCertStorageSettings;
  /**
   * Route passwords ("Require a password"): `rpw_<hex>` reference → the
   * vault-sealed bcrypt hash. Labels carry only the reference; resolved at
   * render time (`ingress-basic-auth.ts`), never returned to a client.
   */
  routePasswords?: Record<string, string>;
  /** Cloudflare tunnel coords (non-secret) + encrypted secret refs. */
  tunnel?: {
    provider?: 'cloudflare';
    accountId?: string;
    tunnelId?: string;
    tunnelName?: string;
    image?: string;
    replicas?: number;
    metricsAddr?: string;
    /** encrypted CF run token */
    runTokenEnc?: string;
    /** encrypted CF API token */
    apiTokenEnc?: string;
    /** encrypted tunnel credentials JSON */
    credentialsJsonEnc?: string;
  };
}

export function readSettings(row: Pick<ConfigRow, 'settings'>): IngressSettings {
  return (row.settings as IngressSettings | null) ?? {};
}

/** Resolve persisted tunnel settings into render-time {@link TunnelOptions} (decrypts). */
function resolveTunnel(s: IngressSettings): TunnelOptions | undefined {
  const t = s.tunnel;
  if (!t) return undefined;
  return {
    provider: 'cloudflare',
    accountId: t.accountId,
    tunnelId: t.tunnelId,
    tunnelName: t.tunnelName ?? 'swarmy',
    image: t.image ?? 'cloudflare/cloudflared:latest',
    replicas: t.replicas ?? 1,
    metricsAddr: t.metricsAddr,
    runToken: t.runTokenEnc ? decryptSecret(t.runTokenEnc) : undefined,
    credentialsJson: t.credentialsJsonEnc ? decryptSecret(t.credentialsJsonEnc) : undefined,
  };
}

/**
 * New orgs start with swarmy's own Caddy edge ON, so a deployed app is
 * browser-reachable with zero setup. Existing rows are never touched — an org
 * that chose NONE (or anything else) keeps it.
 */
export const DEFAULT_INGRESS = { driver: 'CADDY', enabled: true } as const;

/** The org's ingress config (swarm-kv; defaults to {@link DEFAULT_INGRESS} — a read never writes). */
async function ensureConfig(ctx: OrgContext): Promise<ConfigRow> {
  return ingressConfigRepo.get(ctx, ctx.activeOrgId);
}

/**
 * Controller-upstream vhosts: every custom domain that fronts the CONTROLLER
 * rather than a swarm service — status pages (`/s/<slug>`) and inbound webhook
 * endpoints (`/hooks/i/<orgId>/<slug>`). Rows are persisted (StatusPage /
 * InboundEndpoint `domain`); the dial target reuses the scale-to-zero
 * activator's reachable host:port, since both are "the controller from inside
 * an ingress container".
 */
/**
 * Cross-feature guard for controller-vhost domains. Status pages, inbound
 * webhook endpoints, and AI outlets all render one Caddy site block per
 * domain, so a hostname may serve exactly ONE of them (the renderer dedupes
 * defensively, but the collision should be rejected at write time). Call from
 * every writer that sets such a domain; `ignore` names the caller's own row.
 */
export async function assertControllerDomainAvailable(
  ctx: OrgContext,
  domain: string,
  ignore: { statusPageId?: string; inboundEndpointId?: string; aiOutletStack?: string } = {},
): Promise<void> {
  const host = domain.trim().toLowerCase();
  if (!host) return;
  if (host === process.env[DASHBOARD_DOMAIN_ENV]?.trim().toLowerCase()) {
    throw new Error(`domain ${host} is the swarmy dashboard's own address`);
  }
  const [page, endpoint] = await Promise.all([
    ctx.db.statusPage.findFirst({
      where: { orgId: ctx.activeOrgId, domain: host, ...(ignore.statusPageId ? { id: { not: ignore.statusPageId } } : {}) },
      select: { slug: true },
    }),
    ctx.db.inboundEndpoint.findFirst({
      where: { orgId: ctx.activeOrgId, domain: host, ...(ignore.inboundEndpointId ? { id: { not: ignore.inboundEndpointId } } : {}) },
      select: { slug: true },
    }),
  ]);
  if (page) throw new Error(`domain ${host} is already used by status page "${page.slug}"`);
  if (endpoint) throw new Error(`domain ${host} is already used by webhook endpoint "${endpoint.slug}"`);
  const outlets = await listAiOutlets(ctx);
  const outlet = outlets.find((o) => o.domain === host && o.stack !== ignore.aiOutletStack);
  if (outlet) throw new Error(`domain ${host} is already used by the AI outlet for stack "${outlet.stack}"`);
}

/** Env the self-host stack sets to the https dashboard domain (installer-derived). */
export const DASHBOARD_DOMAIN_ENV = 'SWARMY_DASHBOARD_DOMAIN';

/**
 * The dashboard domain this org's edge must serve, or null. Requires BOTH the
 * controller env (the installer's intent — removing it via `--no-https` drops
 * the vhost at once) AND the org's settings binding written by the bootstrap
 * seed (so only the bootstrap org claims it, never every org on the controller).
 */
export function dashboardDomainFor(
  settings: { dashboardDomain?: string },
  env: Record<string, string | undefined> = process.env,
): string | null {
  const d = env[DASHBOARD_DOMAIN_ENV]?.trim().toLowerCase();
  if (!d) return null;
  return settings.dashboardDomain?.trim().toLowerCase() === d ? d : null;
}

/**
 * Where the edge dials the controller for the dashboard vhost: the stack's
 * service name on the shared `swarmy` overlay (both Caddy topologies attach it).
 */
function dashboardUpstream(): string {
  return process.env.SWARMY_DASHBOARD_UPSTREAM || 'swarmy_controller:3021';
}

/** Why the dashboard domain is NOT being served by this driver (null = it is). */
export function dashboardDriverWarning(driver: IngressDriverId, enabled: boolean, domain: string | null): string | null {
  if (!domain) return null;
  if (driver !== 'caddy') {
    return `The dashboard's https address (https://${domain}) is served by swarmy's Caddy edge. With the ${driver} driver it is not served — switch back to Caddy, or use the direct http address until you do.`;
  }
  if (!enabled) {
    return `Ingress is disabled, so the dashboard's https address (https://${domain}) is not served. Re-enable it, or use the direct http address meanwhile.`;
  }
  return null;
}

async function computeControllerVhosts(ctx: OrgContext, settings: IngressSettings = {}): Promise<ControllerVhost[]> {
  const upstream = activatorUpstream();
  const [pages, endpoints, outlets] = await Promise.all([
    ctx.db.statusPage.findMany({
      where: { orgId: ctx.activeOrgId, enabled: true, domain: { not: null } },
      select: { slug: true, domain: true },
    }),
    ctx.db.inboundEndpoint.findMany({
      where: { orgId: ctx.activeOrgId, domain: { not: null } },
      select: { slug: true, domain: true },
    }),
    listAiOutlets(ctx),
  ]);
  const out: ControllerVhost[] = [];
  // Self-hosted mesh behind the edge (TLS handover): the mesh domain's vhost.
  out.push(...(await meshControlVhosts(ctx)));
  const dashboard = dashboardDomainFor(settings);
  if (dashboard) {
    out.push({ domain: dashboard, upstream: dashboardUpstream(), targetPath: '/', kind: 'dashboard', tls: 'auto' });
  }
  for (const p of pages) {
    if (!p.domain) continue;
    out.push({
      domain: p.domain,
      upstream,
      targetPath: `/s/${p.slug}`,
      kind: 'status-page',
      tls: 'auto',
    });
  }
  for (const e of endpoints) {
    if (!e.domain) continue;
    out.push({
      domain: e.domain,
      upstream,
      targetPath: `/hooks/i/${ctx.activeOrgId}/${e.slug}`,
      kind: 'webhook',
      tls: 'auto',
    });
  }
  // Per-stack AI-gateway outlets: the whole domain proxies the gateway mount.
  for (const o of outlets) {
    if (!o.domain) continue;
    out.push({
      domain: o.domain,
      upstream,
      targetPath: '/ai',
      kind: 'ai-gateway',
      tls: 'auto',
    });
  }
  return out;
}

export type Topology = NonNullable<IngressSettings['topology']>;

/**
 * Resolve the org's full driver config. `overrides.topology` renders it as if
 * that topology were live and `overrides.row` as if a not-yet-saved settings
 * patch were persisted — the topology switch validates the target config
 * BEFORE swapping any service or persisting anything (ingress-topology.ts).
 */
export async function loadOrgConfig(
  ctx: OrgContext,
  overrides: {
    topology?: Topology;
    certStorage?: EdgeCertStorageSettings;
    row?: Pick<ConfigRow, 'driver' | 'enabled' | 'settings'>;
  } = {},
): Promise<OrgIngressConfig> {
  const row = overrides.row ?? (await ensureConfig(ctx));
  const persisted = readSettings(row);
  const settings: IngressSettings = {
    ...persisted,
    ...(overrides.topology ? { topology: overrides.topology } : {}),
    ...(overrides.certStorage ? { certStorage: overrides.certStorage } : {}),
  };
  // Per-service routes are Docker-truth: read straight off the live service labels,
  // never the DB. The owning service of a route supplies the upstream name.
  const serviceRoutes = listRoutesForOrg(ctx);
  const baseGlobal = (settings.globalOptions as OrgIngressConfig['globalOptions']) ?? ({} as OrgIngressConfig['globalOptions']);
  // Live scale-to-zero state: a domain whose service is asleep routes to the activator.
  const coldRoutes = computeColdRoutes(ctx);
  // Thread the configured controller image into extraConfig so driver validate()
  // can warn when a rate-limited route meets the stock (plugin-less) image.
  const extraConfig: Record<string, unknown> = {
    ...((baseGlobal?.extraConfig as Record<string, unknown> | undefined) ?? {}),
  };
  // validate() must judge the image Caddy really runs — the configured one, else
  // the default swarmy build (both topologies deploy it).
  extraConfig.controllerImage = settings.controllerImage ?? defaultEdgeImage();
  // Country rules read the org's country database: the DB-IP Country Lite
  // bundled in swarmy's Caddy build by default, an operator mmdb, or off.
  const geoip = resolveEdgeGeoip(edgeGeoipInputs(settings as Record<string, unknown>));
  if (geoip.path) extraConfig.geoipMmdbPath = geoip.path;
  else delete extraConfig.geoipMmdbPath;
  // A configured automatic-address base (the cluster zone first): private-IP
  // names under it get the local CA.
  const wildcardBase = wildcardBaseFrom(settings as Record<string, unknown>, process.env, await clusterZoneName(ctx));
  if (wildcardBase) extraConfig.autoAddressBase = wildcardBase;
  // Edge-per-node topology renders per node (region-aware) and each node's
  // agent writes its config INSIDE its local edge task, then reloads — see
  // caddy driver applyVia 'local'.
  if (settings.topology === 'edge-per-node') {
    extraConfig.applyVia = 'local';
  }
  // Replicated controller (default topology): deliver config by exec'ing into
  // the controller task on the node that hosts it. The legacy default ('file')
  // wrote the Caddyfile on the AGENT host and ran `caddy reload` there — where
  // no Caddy exists — so routes never reached the controller. An operator
  // override (`extraConfig.applyVia`, e.g. 'admin') still wins.
  else if (typeof extraConfig.applyVia !== 'string') extraConfig.applyVia = 'exec';
  // Observability on ⇒ render the `tracing` directive so the edge emits a span
  // per request (the controller carries the matching OTLP exporter env).
  const obs = await observabilityConfigRepo.find(ctx, ctx.activeOrgId).catch(() => null);
  const tracing = obs?.enabled === true;
  // Geo-edge: services with materialised region siblings render region-ordered
  // multi-upstream proxies (same-region first, cross-region failover).
  const liveServices = ctx.hub.liveInventory(ctx.activeOrgId).services;
  // Web analytics / session replay: per-app `swarmy.rum` settings + the route's own toggle.
  const rumFor = rumRouteResolver(ctx, activatorUpstream());
  // Require a password: the label names users + vault references; the edge gets the hashes.
  const basicAuthFor = basicAuthResolver(persisted as unknown as Record<string, unknown>);
  const allDomains = serviceRoutes.map(({ serviceName, stack, route, expose }) => ({
      domain: route.host,
      pathPrefix: route.path ?? '/',
      service: serviceName,
      port: route.port,
      tls: routeTlsToTlsMode(route.tls),
      stripPathPrefix: route.stripPrefix ?? false,
      middlewares: route.middlewares ?? [],
      cold: coldRoutes.get(serviceName),
      // Weighted canary upstream (D2) — carried on the route label, pure render input.
      canary: route.canary,
      // Edge protections — carried on the route label, pure render input.
      protection: route.protection,
      regionUpstreams: regionUpstreamsFor(serviceName, route.port, liveServices),
      rum: rumFor(stack, route.rum),
      ...(route.protection?.basicAuth ? { basicAuth: basicAuthFor(route.protection) } : {}),
      // Protect my app: forward-auth to the controller (the activator's dial target).
      ...(route.access?.login
        ? { auth: { upstream: activatorUpstream(), verifyPath: appAuthVerifyPath(ctx.activeOrgId) } }
        : {}),
      // Declared exposure (swarmy.expose): the renderers withhold private/mesh
      // routes and keep tunnel-only ones off the public edge.
      ...(expose ? { expose } : {}),
      // Per-route driver override: `cloudflared` moves the route onto the tunnel side.
      ...(route.driver ? { driver: route.driver } : {}),
    }));
  // Apex ↔ www toggles expand into plain routes + redirect sites, then the DNS
  // gate withholds every host whose DNS has not yet verifiably pointed at us —
  // so the edge never asks Let's Encrypt for a name that cannot validate.
  const wwwModes = new Map<string, WwwMode>();
  for (const { route } of serviceRoutes) if (route.www && !wwwModes.has(route.host)) wwwModes.set(route.host, route.www);
  const expanded = expandWww(allDomains, wwwModes);
  const checks = domainChecksOf(persisted as unknown as Record<string, unknown>);
  const served = (host: string) => !isHostGated(checks, normalizeHostname(host));
  const servedRoutes = expanded.routes.filter((d) => served(d.domain));
  // Wildcards: ACME DNS-01 through swarmy's own nameservers (or a BYO token).
  const { dnsChallenge } = await orgDnsChallenge(
    ctx,
    servedRoutes.map((d) => normalizeHostname(d.domain)),
    persisted,
  ).catch(() => ({ dnsChallenge: undefined }));
  return {
    driver: driverLower(row.driver),
    enabled: row.enabled,
    orgId: ctx.activeOrgId,
    targetNodes: settings.targetNodes ?? [],
    domains: servedRoutes,
    hostRedirects: expanded.redirects.filter((r) => served(r.from) && served(r.to)),
    ...(dnsChallenge ? { dnsChallenge } : {}),
    // Controller-upstream vhosts (status-page / webhook domains) — persisted rows
    // resolved at render time onto the controller upstream.
    controllerVhosts: await computeControllerVhosts(ctx, settings),
    // Per-bucket S3 exposure (public hostname + mesh listener), edge-enforced.
    objectStorage: await objectStorageEdgeFor(ctx, settings.dashboardDomain),
    globalOptions: {
      ...baseGlobal,
      extraConfig,
      tracing,
      // Per-host request metrics (Q4): each edge's agent scrapes Caddy's
      // local /metrics for per-region / per-app request rates.
      requestMetrics: true,
      // Shared cert store: edge-per-node only (the single controller keeps
      // Caddy's local file storage — nothing to coordinate, and no dependency
      // on object storage for the only edge). Coordinates only — no secrets.
      certStorage:
        settings.topology === 'edge-per-node' && settings.certStorage
          ? certStorageFor(settings.certStorage)
          : undefined,
      // Promote the load-bearing (encrypted) options, resolving secrets JIT.
      tunnel: resolveTunnel(settings),
    },
  };
}

/**
 * In-task delivery: the replicated controller (`exec`) and edge-per-node
 * (`local`) both write the Caddyfile INSIDE the running task over the docker
 * socket, so the only valid targets are the nodes hosting a running task.
 */
function usesInTaskExec(config: OrgIngressConfig): boolean {
  const extra = (config.globalOptions?.extraConfig ?? {}) as Record<string, unknown>;
  return config.driver === 'caddy' && (extra.applyVia === 'exec' || extra.applyVia === 'local');
}

function makeDispatch(ctx: OrgContext, config?: OrgIngressConfig): DriverDispatch {
  // In-task exec (replicated controller AND edge-per-node): the only valid
  // targets are the nodes that host a running Caddy task — Docker truth, not
  // the pin/label set. For edge-per-node that is EVERY edge node.
  const execTargets = config && usesInTaskExec(config) ? () => ingressTaskNodes(ctx) : undefined;
  return {
    async resolveTargetNodes(orgId, explicit) {
      if (execTargets) return execTargets();
      if (explicit.length) return explicit;
      // Prefer nodes tagged as the ingress (edge) tier via the node-role label;
      // fall back to the manager set when no node is marked so ingress still applies.
      const marked = await ingressTargetNodes(ctx);
      return marked.length ? marked : ctx.hub.managerNodes(orgId);
    },
    async resolveTargets(orgId, explicit) {
      const ids = execTargets
        ? await execTargets()
        : explicit.length
        ? explicit
        : await (async () => {
            const marked = await ingressTargetNodes(ctx);
            return marked.length ? marked : ctx.hub.managerNodes(orgId);
          })();
      return ids.map((nodeId) => ({
        nodeId,
        region: ctx.hub.nodeInfoFor(nodeId)?.labels?.['swarmy.region'] || undefined,
      }));
    },
    async sendToNode(nodeId, rendered: RenderedConfig) {
      try {
        await ctx.hub.dispatch(nodeId, 'applyIngress', { rendered });
        return { nodeId, ok: true };
      } catch (e) {
        return { nodeId, ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    },
    async queryStatus(nodeId, driver): Promise<IngressStatus> {
      const online = ctx.hub.isOnline(nodeId);
      return {
        driver,
        healthy: online,
        activeDomains: [],
        certs: [],
        message: online ? 'online' : 'offline',
      };
    },
  };
}

// ───────────────────────────────────────────── runtime truth + convergence ──

/**
 * Outcome of the most recent render+apply (or controller converge) per org.
 * In-process on purpose: it is operational telemetry, not config — after a
 * controller restart it is empty until the ingress-reconcile worker's first
 * tick re-applies (runtime reads `deploying` meanwhile, never a false green).
 */
const lastApplyByOrg = new Map<string, EdgeApplyRecord>();

export function recordApply(orgId: string, ok: boolean, message: string): void {
  lastApplyByOrg.set(orgId, { ok, at: new Date().toISOString(), message });
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Live runtime status of the org edge (Docker truth + last apply). */
export async function edgeRuntimeStatus(
  ctx: OrgContext,
  row?: ConfigRow,
): Promise<EdgeRuntimeStatus> {
  const cfg = row ?? (await ensureConfig(ctx));
  const svc = ctx.hub
    .liveInventory(ctx.activeOrgId)
    .services.find((s) => s.name === CADDY_CONTROLLER_SERVICE);
  const taskNodes = driverLower(cfg.driver) === 'caddy' ? await ingressTaskNodes(ctx) : [];
  return deriveEdgeRuntime({
    driver: driverLower(cfg.driver),
    enabled: cfg.enabled,
    service: svc
      ? {
          runningReplicas: svc.runningReplicas,
          desiredReplicas: svc.desiredReplicas,
          mode: svc.mode,
          updatedAt: svc.updatedAt,
        }
      : undefined,
    taskHosts: taskNodes.map((id) => ctx.hub.nodeInfoFor(id)?.hostname ?? id),
    lastApply: lastApplyByOrg.get(ctx.activeOrgId),
    now: Date.now(),
  });
}

/**
 * Converge the swarmy-run Caddy for the current topology when the org's edge
 * is Caddy + enabled — the step that used to hide behind a separate "Deploy /
 * converge controller" button. Idempotent (`service.deploy` is create+update).
 * A failure is RECORDED (surfaces on `runtime`) and returned, never swallowed.
 */
export async function convergeEdge(ctx: OrgContext): Promise<string | null> {
  const row = await ensureConfig(ctx);
  if (driverLower(row.driver) !== 'caddy' || !row.enabled) return null;
  const settings = readSettings(row);
  // Operator opted into a self-run Caddy on the host (`applyVia: 'file'`):
  // swarmy must not deploy a competing controller onto 80/443.
  const extra = (settings.globalOptions?.extraConfig ?? {}) as Record<string, unknown>;
  if (extra.applyVia === 'file') return null;
  try {
    await deployTopology(ctx, settings.topology ?? 'controller', settings);
    return null;
  } catch (e) {
    const message = `could not deploy the Caddy ingress controller: ${errMessage(e)}`;
    recordApply(ctx.activeOrgId, false, message);
    return message;
  }
}

/** Is the swarmy Caddy service present in live inventory? */
function edgeServiceDeployed(ctx: OrgContext): boolean {
  return liveEdgeMode(ctx) !== undefined;
}

/** Live mode of the swarmy Caddy service (undefined = not deployed). */
export function liveEdgeMode(ctx: OrgContext): 'replicated' | 'global' | undefined {
  return ctx.hub
    .liveInventory(ctx.activeOrgId)
    .services.find((s) => s.name === CADDY_CONTROLLER_SERVICE)?.mode;
}

/** The swarm service mode a topology runs as. */
export function modeForTopology(topology: Topology | undefined): 'replicated' | 'global' {
  return topology === 'edge-per-node' ? 'global' : 'replicated';
}

/** Deploy the swarmy Caddy for `topology` (mode swap handled by ingress-controller). */
export async function deployTopology(
  ctx: OrgContext,
  topology: Topology,
  settings: IngressSettings,
): Promise<void> {
  // Wildcard certificates (DNS-01): mount the provider token secret(s) the
  // render's `dns swarmy` / `dns cloudflare` blocks read. Never fails a deploy.
  const acmeDnsSecrets = await edgeAcmeDnsSecrets(ctx, settings).catch(() => []);
  if (topology === 'edge-per-node') {
    await ensureCaddyEdge(ctx, {
      image: settings.controllerImage ?? undefined,
      certStoreSecret: settings.certStorage?.secretName,
      certStoreEncSecret: settings.certStorage?.encSecretName,
      acmeDnsSecrets,
    });
    return;
  }
  const extra = (settings.globalOptions?.extraConfig ?? {}) as Record<string, unknown>;
  await ensureCaddyController(ctx, {
    image: settings.controllerImage ?? undefined,
    targetNodes: settings.targetNodes ?? [],
    adminOnOverlay: extra.applyVia === 'admin',
    acmeDnsSecrets,
  });
}

/** Cert-store truth for the topology card (never a credential). */
async function certStorageView(
  ctx: OrgContext,
  row: ConfigRow,
  settings: IngressSettings,
): Promise<EdgeCertStorageView> {
  const shared = (settings.topology ?? 'controller') === 'edge-per-node' && Boolean(settings.certStorage);
  const edges = driverLower(row.driver) === 'caddy' ? (await ingressTaskNodes(ctx)).length : 0;
  const store = await objectStoreState(ctx).catch(() => ({ enabled: false as const }));
  return {
    mode: shared ? 'shared' : 'local',
    edges,
    objectStorageEnabled: store.enabled,
    bucket: shared ? settings.certStorage!.bucket : null,
    encrypted: shared && Boolean(settings.certStorage!.encSecretName),
  };
}

export async function getConfig(ctx: OrgContext): Promise<IngressConfigView> {
  const row = await ensureConfig(ctx);
  const settings = readSettings(row);
  // Domain count is Docker-truth: number of routes across the org's service labels.
  const domainCount = listRoutesForOrg(ctx).length;
  return {
    driver: driverLower(row.driver),
    enabled: row.enabled,
    targetNodes: settings.targetNodes ?? [],
    domainCount,
    certStorage: await certStorageView(ctx, row, settings),
    tunnelConfigured: Boolean(settings.tunnel?.tunnelId),
    controllerImage: settings.controllerImage ?? null,
    defaultControllerImage: defaultEdgeImage(),
    topology: settings.topology ?? 'controller',
    dashboardDomain: dashboardDomainFor(settings),
    dashboardWarning: dashboardDriverWarning(driverLower(row.driver), row.enabled, dashboardDomainFor(settings)),
    updatedAt: row.updatedAt.toISOString(),
    runtime: await edgeRuntimeStatus(ctx, row),
  };
}

/** The configured controller image, or null for the stock default. */
export async function getControllerImage(ctx: OrgContext): Promise<string | null> {
  const row = await ensureConfig(ctx);
  return readSettings(row).controllerImage ?? null;
}

/** The key edge cert sync holds (platform-key GC, QA-081). */
export async function edgeCertStorageKeyIds(ctx: OrgContext): Promise<string[]> {
  const row = await ingressConfigRepo.find(ctx, ctx.activeOrgId);
  const id = row ? readSettings(row).certStorage?.accessKeyId : undefined;
  return id ? [id] : [];
}

/** Merge a partial patch into the persisted settings JSON. */
export async function patchSettings(
  ctx: OrgContext,
  patch: (s: IngressSettings) => IngressSettings,
): Promise<void> {
  await ingressConfigRepo.update(ctx, ctx.activeOrgId, (cur) => ({
    settings: patch(readSettings(cur)) as Record<string, unknown>,
  }));
}

/**
 * A Cloudflare tunnel run token is base64 JSON `{ a: accountTag, t: tunnelId,
 * s: secret }`. Returns the tunnel id, or null when it isn't one.
 */
export function tunnelIdFromToken(token: string): string | null {
  try {
    const json = JSON.parse(Buffer.from(token.trim(), 'base64').toString('utf8')) as { t?: unknown };
    return typeof json.t === 'string' && /^[0-9a-f-]{32,36}$/i.test(json.t) ? json.t : null;
  } catch {
    return null;
  }
}

export async function listDomains(ctx: OrgContext, stack?: string): Promise<DomainView[]> {
  // Routes are Docker-truth: project each service's `swarmy.ingress.routes` label.
  // The DomainView id is {@link domainId} (the handle removeDomain parses back).
  // `stack` scopes the list to services in that Docker stack (namespace label).
  const runtime = await edgeRuntimeStatus(ctx);
  const statuses = await domainStatusMap(ctx).catch(() => new Map<string, DomainStatusView>());
  return listRoutesForOrg(ctx)
    .filter((r) => !stack || r.stack === stack)
    .map(({ serviceId, serviceName, stack: svcStack, route, auto, expose }) => {
      const companion = route.www ? companionHost(route.host) : null;
      return {
        id: domainId(serviceId, route.host, route.path),
        host: route.host,
        serviceId,
        serviceName,
        stack: svcStack,
        targetPort: route.port,
        tls: routeTlsToTlsMode(route.tls),
        pathPrefix: route.path ?? null,
        ingressDriver: (route.driver as IngressDriverId | undefined) ?? null,
        protection: route.protection ?? null,
        canaryPct: route.canary ? route.canary.weightPct : null,
        serving: runtime.serving,
        edgeState: runtime.state,
        www: route.www ?? null,
        companionHost: companion,
        status: statuses.get(normalizeHostname(route.host)) ?? null,
        companionStatus: companion ? statuses.get(companion) ?? null : null,
        auto: auto ?? false,
        expose: expose ?? null,
      };
    });
}

export async function addDomain(
  ctx: OrgContext,
  input: {
    host: string;
    serviceId: string;
    targetPort: number;
    tls: TlsMode;
    pathPrefix?: string;
    /** Per-domain driver override; null/undefined inherits the org default. */
    ingressDriver?: IngressDriverId | null;
    /** Apex ↔ www toggle (null/undefined = only `host`). */
    www?: WwwMode | null;
  },
): Promise<DomainView> {
  // Resolve the target from live Docker inventory (no Service table). The route is
  // persisted on the service's `swarmy.ingress.routes` label — Docker is the truth.
  const service = resolveLiveService(ctx, input.serviceId);
  if (!service) throw notFound('service', input.serviceId);
  const host = normalizeHostname(input.host);
  if (!host) throw new TRPCError({ code: 'BAD_REQUEST', message: 'host is required' });
  if (host === process.env[DASHBOARD_DOMAIN_ENV]?.trim().toLowerCase()) {
    throw new Error(`domain ${host} is the swarmy dashboard's own address`);
  }
  if (input.www && !companionHost(host)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: `${host} has no www companion (wildcards and IPs can't pair)` });
  }
  const pathPrefix = input.pathPrefix && input.pathPrefix !== '/' ? input.pathPrefix : undefined;

  // Read the service's current routes, replace the route with the same host+path
  // (other paths on the same host are separate routes and stay), then write the
  // whole array back as the label value.
  const routes = readRoutes(service.labels).filter((r) => !sameRoute(r, host, pathPrefix));
  const route: Route = { host, port: input.targetPort, tls: tlsModeToRouteTls(input.tls) };
  if (pathPrefix) route.path = pathPrefix;
  if (input.ingressDriver) route.driver = input.ingressDriver;
  if (input.www) route.www = input.www;
  routes.push(route);

  // Register the host (and its companion) for DNS verification BEFORE the label
  // lands, so the first render already withholds it until DNS points at us.
  await registerDomainHosts(ctx, [route]);

  // The label IS the source of truth, so this dispatch must land (not best-effort).
  // `swarmy.ingress` is kept in sync so the service-summary ingress indicator stays lit.
  const node = await resolveManagerNode(ctx);
  await ctx.hub.dispatch(node.id, 'service.updateLabels', {
    service: service.name,
    add: { [INGRESS_ROUTES_LABEL]: serializeRoutes(routes), [INGRESS_ENABLED_LABEL]: 'true' },
    removeKeys: [],
  });

  await reapply(ctx);
  // Kick the first DNS check now (background): if DNS already points here the
  // domain goes live in seconds instead of waiting for the worker's tick.
  void import('./domain-verify.service')
    .then((m) => m.verifyDomainNow(ctx, host))
    .catch(() => undefined);
  const runtime = await edgeRuntimeStatus(ctx);
  const statuses = await domainStatusMap(ctx).catch(() => new Map<string, DomainStatusView>());
  const companion = input.www ? companionHost(host) : null;
  return {
    id: domainId(service.id, host, pathPrefix),
    host,
    serviceId: service.id,
    serviceName: service.name,
    stack: service.stack,
    targetPort: input.targetPort,
    tls: input.tls,
    pathPrefix: pathPrefix ?? null,
    ingressDriver: input.ingressDriver ?? null,
    protection: null,
    canaryPct: null,
    serving: runtime.serving,
    edgeState: runtime.state,
    www: input.www ?? null,
    companionHost: companion,
    status: statuses.get(host) ?? null,
    companionStatus: companion ? statuses.get(companion) ?? null : null,
    auto: false,
  };
}

export async function removeDomain(
  ctx: OrgContext,
  id: string,
): Promise<{ id: string; removed: true }> {
  // See domainId: service ids are colon-free, hosts never contain '/'.
  const { serviceId, host, path } = parseDomainId(id);
  const service = resolveLiveService(ctx, serviceId);
  if (!service) throw notFound('domain', id);

  const current = readRoutes(service.labels);
  const remaining = current.filter((r) => !sameRoute(r, host, path));
  if (remaining.length === current.length) throw notFound('domain', id);
  const node = await resolveManagerNode(ctx);
  if (remaining.length === 0) {
    // Empty array → drop the label entirely (and the now-orphaned ingress flag).
    await ctx.hub.dispatch(node.id, 'service.updateLabels', {
      service: service.name,
      add: {},
      removeKeys: [INGRESS_ROUTES_LABEL, INGRESS_ENABLED_LABEL],
    });
  } else {
    await ctx.hub.dispatch(node.id, 'service.updateLabels', {
      service: service.name,
      add: { [INGRESS_ROUTES_LABEL]: serializeRoutes(remaining) },
      removeKeys: [],
    });
  }
  await reapply(ctx);
  return { id, removed: true };
}

/**
 * Set (or clear, `null`) the apex ↔ www toggle on one route. Every route of the
 * same host on the service moves together (the toggle is per host). The new
 * companion host is registered for DNS verification before the label lands.
 */
export async function setDomainWww(ctx: OrgContext, id: string, www: WwwMode | null): Promise<DomainView> {
  const { serviceId, host, path } = parseDomainId(id);
  const service = resolveLiveService(ctx, serviceId);
  if (!service) throw notFound('domain', id);
  const current = readRoutes(service.labels);
  if (!current.some((r) => sameRoute(r, host, path))) throw notFound('domain', id);
  if (www && !companionHost(host)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: `${host} has no www companion (wildcards and IPs can't pair)` });
  }
  const next = current.map((r) => {
    if (r.host !== host) return r;
    const { www: _drop, ...rest } = r;
    return www ? { ...rest, www } : rest;
  });
  if (www) await registerDomainHosts(ctx, next.filter((r) => r.host === host));
  const node = await resolveManagerNode(ctx);
  await ctx.hub.dispatch(node.id, 'service.updateLabels', {
    service: service.name,
    add: { [INGRESS_ROUTES_LABEL]: serializeRoutes(next) },
    removeKeys: [],
  });
  await writeAudit(ctx, {
    action: 'ingress.setDomainWww',
    targetType: 'domain',
    targetId: id,
    metadata: { host, www },
  });
  await reapply(ctx);
  if (www) {
    void import('./domain-verify.service')
      .then((m) => m.verifyDomainNow(ctx, host))
      .catch(() => undefined);
  }
  // Re-read through the live view (the label write may not be in the snapshot yet).
  const rows = await listDomains(ctx);
  const row = rows.find((r) => r.id === id);
  if (row) return { ...row, www, companionHost: www ? companionHost(host) : null };
  throw notFound('domain', id);
}

export async function previewConfig(
  ctx: OrgContext,
  driver?: IngressDriverId,
): Promise<RenderedConfig> {
  const config = await loadOrgConfig(ctx);
  const rendered = previewConfigPkg({ ...config, driver: driver ?? config.driver, enabled: true });
  // Members read the preview: tunnel tokens, credentials files and route-password
  // hashes stay sealed in it (the dispatched render is the only one that carries them).
  return redactRenderedSecrets(rendered);
}

/**
 * Render + dispatch one loaded config and RECORD the outcome, so failures reach
 * `runtime` (and the dashboard) instead of vanishing. Throws on failure.
 */
async function applyAndRecord(ctx: OrgContext, config: OrgIngressConfig): Promise<IngressStatus> {
  // swarmy's own Caddy can only proxy to services on its overlay.
  if (config.driver === 'caddy') await attachRoutedServicesToEdge(ctx).catch(() => []);
  try {
    const status = await applyIngressPkg(config, makeDispatch(ctx, config));
    // Routes that opt into the tunnel (route driver `cloudflared` / declared
    // tunnel) on a Caddy org: run the tunnel half too. Its outcome rides on the
    // recorded message; it never fails the public edge's apply.
    const side = tunnelSideConfig(config);
    const tunnel = side
      ? await applyIngressPkg(side, makeDispatch(ctx, side)).then(
          (s) => `tunnel: ${s.message ?? 'applied'}`,
          (e: unknown) => `tunnel failed: ${errMessage(e)}`,
        )
      : null;
    const message = [status.message ?? 'applied', tunnel].filter(Boolean).join(' · ');
    recordApply(ctx.activeOrgId, true, message);
    return { ...status, message };
  } catch (e) {
    recordApply(ctx.activeOrgId, false, errMessage(e));
    throw e;
  }
}

/**
 * Render + dispatch the current config to the ingress nodes. Never throws (a
 * config write must not fail because the proxy is down), but never hides the
 * failure either: the outcome is recorded and read back through `runtime`.
 * While the in-task controller has no running task yet (just deployed, still
 * pulling) the apply is deferred — the ingress-reconcile worker applies the
 * moment a task appears — rather than recorded as a failure.
 *
 * `converged`: the caller deployed the edge a moment ago, so live inventory
 * may not show it yet — skip the self-heal deploy (one converge per write).
 */
export async function reapply(
  ctx: OrgContext,
  opts: { converged?: boolean } = {},
): Promise<IngressStatus | null> {
  const config = await loadOrgConfig(ctx);
  if (config.driver === 'none' || !config.enabled) return null;
  if (usesInTaskExec(config) && (await ingressTaskNodes(ctx)).length === 0) {
    // Self-heal: Caddy enabled but the controller is gone → deploy it again.
    if (!opts.converged && !edgeServiceDeployed(ctx)) await convergeEdge(ctx);
    return null;
  }
  return applyAndRecord(ctx, config).catch(() => null);
}

export async function applyNow(ctx: OrgContext): Promise<IngressStatus> {
  const config = await loadOrgConfig(ctx);
  return applyAndRecord(ctx, config);
}

/**
 * Load the resolved org ingress config (secrets decrypted JIT) for the tunnel
 * service — used to recompute the Cloudflare ingress-rule array. Exported wrapper
 * over the internal {@link loadOrgConfig}.
 */
export async function loadOrgConfigForTunnels(ctx: OrgContext): Promise<OrgIngressConfig> {
  return loadOrgConfig(ctx);
}

/** Deps for the worker-side cold-ingress reconcile (no HTTP session). */
export interface IngressColdReconcileDeps {
  db: DB;
  hub: AgentHub;
  auth: Auth;
}

/**
 * Force a render + dispatch of one org's ingress under a SYSTEM context (no diff).
 * Used by the activator the instant a service has woken so the affected domain flips
 * from the activator upstream back to a DIRECT one BEFORE the caller is 307'd back —
 * closing the brief redirect-loop window where a warm service is still routed to the
 * activator. Best-effort: disabled/`none` ingress is a no-op; failures are swallowed.
 */
/**
 * Per-region edge posture (geo-edge contract): ingress nodes with their public
 * IP and live Caddy/DNS task state. ONE source read by the DNS snapshot
 * builder, the dashboard, and diagnostics — never re-derive this elsewhere.
 */
export interface IngressRegionSnapshot {
  region: string;
  nodes: Array<{
    nodeId: string;
    publicIp: string | null;
    online: boolean;
    caddyRunning: boolean | null; // null = no telemetry reported yet
    dnsRunning: boolean | null;
    sampledAt: number | null;
  }>;
}

export function ingressRegionSnapshot(ctx: OrgContext): IngressRegionSnapshot[] {
  const byRegion = ctx.hub.nodesByRegion(ctx.activeOrgId);
  const ingress = new Set(ctx.hub.nodesByRole(ctx.activeOrgId, 'ingress'));
  const out: IngressRegionSnapshot[] = [];
  for (const [region, nodeIds] of byRegion) {
    const nodes = nodeIds
      .filter((id) => ingress.has(id))
      .map((nodeId) => {
        const edge = ctx.hub.ingressStatusFor(nodeId);
        return {
          nodeId,
          publicIp: publicIpFromLabels(ctx.hub.nodeInfoFor(nodeId)?.labels),
          online: ctx.hub.isOnline(nodeId),
          caddyRunning: edge?.caddyRunning ?? null,
          dnsRunning: edge?.dnsRunning ?? null,
          sampledAt: edge?.sampledAt ?? null,
        };
      });
    if (nodes.length > 0) out.push({ region, nodes });
  }
  return out.sort((a, b) => (a.region < b.region ? -1 : 1));
}

export async function reapplyIngressForOrg(
  deps: IngressColdReconcileDeps,
  orgId: string,
): Promise<void> {
  const ctx = systemContext(deps, orgId);
  const config = await loadOrgConfig(ctx);
  if (config.driver === 'none' || !config.enabled) return;
  await applyAndRecord(ctx, config).catch(() => undefined);
}

/**
 * Scale-to-zero ingress reconcile (epic #4B). Recompute the set of COLD domains
 * (scale-to-zero services at 0 running replicas that back a domain) for one org
 * from live Docker state and, when that set differs from `prevColdHosts`, re-render
 * + dispatch the org's ingress — so a domain that just went cold flips to the
 * activator upstream and one that just warmed flips back to a direct upstream.
 *
 * Returns the freshly-computed cold-host set (sorted) for the caller to cache and
 * pass back next tick. A no-op (returns the set, no dispatch) when ingress is
 * disabled or the driver is `none`. Best-effort: a dispatch failure is swallowed so
 * one unhealthy org never stalls the worker.
 *
 * Runs under a SYSTEM `OrgContext` (no session) — same seam the GC/webhook workers use.
 */
export async function reconcileColdIngress(
  deps: IngressColdReconcileDeps,
  orgId: string,
  prevColdHosts: readonly string[],
): Promise<string[]> {
  const ctx = systemContext(deps, orgId);
  const config = await loadOrgConfig(ctx);
  const coldHosts = config.domains
    .filter((d) => d.cold)
    .map((d) => d.domain)
    .sort();
  if (config.driver === 'none' || !config.enabled) return coldHosts;
  const prev = [...prevColdHosts].sort();
  const unchanged =
    prev.length === coldHosts.length && prev.every((h, i) => h === coldHosts[i]);
  if (unchanged) return coldHosts;
  try {
    await applyAndRecord(ctx, config);
    return coldHosts;
  } catch {
    // Apply failed — return the PREVIOUS set so the caller's cache is unchanged and
    // the (still-differing) cold set re-triggers a dispatch on the next tick.
    return [...prevColdHosts];
  }
}

/** Result of one {@link reconcileIngressOrg} tick for an org. */
export interface IngressReconcileResult {
  /**
   * Signature to hold for the next tick — or `null` when nothing converged
   * (apply failed / controller not up yet), so the next tick retries.
   */
  signature: string | null;
  /** Desired state unchanged since `lastSignature` — zero commands sent. */
  skipped: boolean;
  applied: boolean;
  error?: string;
}

/** Last time (ms) the reconcile re-deployed a missing controller, per org. */
const lastConvergeAt = new Map<string, number>();
const CONVERGE_RETRY_MS = 60_000;
/**
 * Re-render the edge after a bucket's reachability changed. When the mesh
 * listener appears or disappears the edge SERVICE changes (its published
 * ports), so it redeploys first; otherwise a config apply is enough.
 */
export async function applyObjectStorageExposure(ctx: OrgContext, edgePortsChanged: boolean): Promise<void> {
  if (edgePortsChanged) {
    const error = await convergeEdge(ctx);
    if (error) throw commandRejected(error);
  }
  await reapply(ctx);
}

/** Mesh IPs of the nodes running an edge task — where MESH buckets are reachable. */
export async function edgeMeshIps(ctx: OrgContext): Promise<string[]> {
  const nodeIds = await ingressTaskNodes(ctx).catch(() => [] as string[]);
  if (nodeIds.length === 0) return [];
  // Live mesh peers (agent meshState), never a stored row.
  return nodeIds.map((id) => meshPeers.get(id)?.meshIp ?? null).filter((ip): ip is string => Boolean(ip));
}

/** The org's dashboard hostname (the public S3 domain derives from it). */
export async function orgDashboardDomain(ctx: OrgContext): Promise<string | undefined> {
  return readSettings(await ensureConfig(ctx)).dashboardDomain ?? undefined;
}

/**
 * After a legacy plaintext store was upgraded and the sealed config is applied
 * (so each edge's autosave now resumes into the encrypted prefix), restart the
 * edge once: it comes back with an empty cache, finds nothing under the sealed
 * prefix and re-obtains its certificates there. One issuance per domain (the
 * edges share the store's locks). The flag clears even if the restart fails —
 * the next reboot or renewal converges the same way; this only makes it prompt.
 */
async function reissueIntoSealedStore(ctx: OrgContext, config: OrgIngressConfig): Promise<void> {
  if (!config.globalOptions.certStorage?.encryptionKeyFile) return;
  const settings = readSettings(await ensureConfig(ctx));
  const store = settings.certStorage;
  if (!store) return;
  if (store.reissuePending) {
    const manager = ctx.hub.managerNode(ctx.activeOrgId);
    if (!manager) return;
    await ctx.hub
      .dispatch(manager, 'service.restart', { service: CADDY_EDGE_SERVICE, forceNewTask: true })
      .catch(() => undefined);
    await patchSettings(ctx, (prev) =>
      prev.certStorage ? { ...prev, certStorage: { ...prev.certStorage, reissuePending: false } } : prev,
    );
    await writeAudit(ctx, {
      action: 'ingress.reissueSealedCerts',
      actorType: 'system',
      targetType: 'ingressConfig',
      targetId: ctx.activeOrgId,
      metadata: { prefix: store.prefix },
    }).catch(() => undefined);
    return; // purge on a later tick, once the restarted edges are up on the sealed store
  }
  if (store.legacyPrefix) {
    try {
      await purgeLegacyEdgeCerts(ctx, store);
    } catch {
      return; // retried on a later applied tick
    }
    await patchSettings(ctx, (prev) =>
      prev.certStorage ? { ...prev, certStorage: { ...prev.certStorage, legacyPrefix: undefined } } : prev,
    );
    await writeAudit(ctx, {
      action: 'ingress.purgePlaintextCerts',
      actorType: 'system',
      targetType: 'ingressConfig',
      targetId: ctx.activeOrgId,
      metadata: { bucket: store.bucket, prefix: store.legacyPrefix, offsiteCopyKept: true },
    }).catch(() => undefined);
  }
}

/** Last time (ms) the reconcile tried to provision the edge cert store, per org. */
const lastCertStoreAt = new Map<string, number>();

/**
 * Provision the shared cert store for a live edge-per-node org, persist its
 * coordinates, and redeploy the edge with the credentials secret mounted. The
 * next tick's render then carries the `storage swarmy` block. Returns an error
 * message (recorded on `runtime`) or null.
 */
async function adoptEdgeCertStorage(ctx: OrgContext): Promise<string | null> {
  try {
    const current = readSettings(await ensureConfig(ctx)).certStorage;
    const certs = await ensureEdgeCertStorage(ctx, current);
    const upgradedLegacy = Boolean(current && !current.encSecretName && certs.settings.encSecretName);
    const stored = upgradedLegacy
      ? { ...certs.settings, reissuePending: true, legacyPrefix: current!.prefix }
      : certs.settings;
    await patchSettings(ctx, (prev) => ({ ...prev, certStorage: stored }));
    await writeAudit(ctx, {
      action: 'ingress.provisionCertStorage',
      actorType: 'system',
      targetType: 'ingressConfig',
      targetId: ctx.activeOrgId,
      metadata: { bucket: certs.settings.bucket, accessKeyId: certs.settings.accessKeyId },
    }).catch(() => undefined);
  } catch (e) {
    const message = `could not set up shared certificate storage: ${errMessage(e)}`;
    recordApply(ctx.activeOrgId, false, message);
    return message;
  }
  return convergeEdge(ctx);
}

/** Routed services (sorted) not on the edge overlay — part of the reconcile signature. */
function routedServicesMissingEdge(ctx: OrgContext): string[] {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  return servicesMissingEdge(buildInventory(services, containers).services).sort();
}

/**
 * Ingress reconcile (one org, one tick) — the safety net that makes routes
 * actually get served without a human pressing "apply":
 *
 * - desired state = the full resolved org config (routes off live service
 *   labels — incl. ones a blueprint deploy wrote directly — cold/scale-to-zero
 *   upstreams, controller vhosts, TLS/HA options) PLUS the set of running Caddy
 *   task containers. A new/rescheduled task changes the signature, so it gets
 *   its config pushed the tick it appears.
 * - Caddy enabled but the controller service is gone → re-deploy it
 *   (rate-limited to once per minute per org).
 * - Signature-gated: a steady state sends ZERO commands. Failures return a
 *   `null` signature so the next tick retries, and are recorded for `runtime`.
 *
 * Runs under a SYSTEM `OrgContext` (no session).
 */
export async function reconcileIngressOrg(
  deps: IngressColdReconcileDeps,
  orgId: string,
  lastSignature?: string | null,
): Promise<IngressReconcileResult> {
  const ctx = systemContext(deps, orgId);
  const config = await loadOrgConfig(ctx);
  if (config.driver === 'none' || !config.enabled) {
    const signature = `off:${config.driver}:${config.enabled}`;
    return { signature, skipped: signature === lastSignature, applied: false };
  }

  const extra = (config.globalOptions?.extraConfig ?? {}) as Record<string, unknown>;
  const swarmyRunsCaddy = config.driver === 'caddy' && extra.applyVia !== 'file';
  if (swarmyRunsCaddy && !edgeServiceDeployed(ctx)) {
    // No manager connected yet (fresh org, nodes still installing): nothing to
    // deploy onto — wait quietly instead of recording a failure.
    if (!ctx.hub.managerNode(orgId)) return { signature: null, skipped: true, applied: false };
    const last = lastConvergeAt.get(orgId) ?? 0;
    if (Date.now() - last >= CONVERGE_RETRY_MS) {
      lastConvergeAt.set(orgId, Date.now());
      const error = await convergeEdge(ctx);
      return { signature: null, skipped: false, applied: false, error: error ?? undefined };
    }
    return { signature: null, skipped: true, applied: false };
  }

  // Live service is the WRONG mode for the persisted topology (an interrupted
  // switch, a hand edit, an older controller): converge it — the deploy swaps
  // the service (remove + create, volumes kept). Rate-limited like above.
  if (swarmyRunsCaddy) {
    const row = await ensureConfig(ctx);
    const want = modeForTopology(readSettings(row).topology);
    const live = liveEdgeMode(ctx);
    if (live !== undefined && live !== want && ctx.hub.managerNode(orgId)) {
      const last = lastConvergeAt.get(orgId) ?? 0;
      if (Date.now() - last >= CONVERGE_RETRY_MS) {
        lastConvergeAt.set(orgId, Date.now());
        const error = await convergeEdge(ctx);
        return { signature: null, skipped: false, applied: false, error: error ?? undefined };
      }
      return { signature: null, skipped: true, applied: false };
    }
  }

  // Edge-per-node without the shared cert store (switched before it existed,
  // or object storage turned on since): provision it and roll the edge onto
  // the credentials secret — zero setup. Waits quietly while object storage is
  // off (the topology card says why). Rate-limited like the converges above.
  if (swarmyRunsCaddy && ctx.hub.managerNode(orgId)) {
    const settings = readSettings(await ensureConfig(ctx));
    // Also upgrades a legacy plaintext store to encrypted at rest.
    if (settings.topology === 'edge-per-node' && !settings.certStorage?.encSecretName) {
      const last = lastCertStoreAt.get(orgId) ?? 0;
      if (Date.now() - last >= CONVERGE_RETRY_MS && (await objectStoreState(ctx)).enabled) {
        lastCertStoreAt.set(orgId, Date.now());
        const error = await adoptEdgeCertStorage(ctx);
        return { signature: null, skipped: false, applied: false, error: error ?? undefined };
      }
    }
  }

  // Wildcards on DNS-01 need the provider token mounted on the edge: roll the
  // edge onto it when the live service lacks it (first wildcard, token
  // rotation, a new BYO token). Rate-limited like the converges above.
  if (swarmyRunsCaddy && config.dnsChallenge && ctx.hub.managerNode(orgId)) {
    const need = requiredAcmeDnsSecrets(
      config.dnsChallenge,
      readAcmeDnsSettings(readSettings(await ensureConfig(ctx))),
    );
    const mounted = new Set(
      ctx.hub.liveInventory(orgId).services.find((s) => s.name === CADDY_CONTROLLER_SERVICE)?.secrets ?? [],
    );
    if (need.some((n) => !mounted.has(n))) {
      const last = lastConvergeAt.get(orgId) ?? 0;
      if (Date.now() - last >= CONVERGE_RETRY_MS) {
        lastConvergeAt.set(orgId, Date.now());
        const error = await convergeEdge(ctx);
        return { signature: null, skipped: false, applied: false, error: error ?? undefined };
      }
    }
  }

  const tasks = swarmyRunsCaddy ? await ingressTasks(ctx) : [];
  // A routed service can lose the edge overlay after its routes were applied
  // (a stack redeploy rebuilt from compose, a blueprint's later steps). The
  // routes don't change, so without this the signature never moves and Caddy
  // 502s on "no such host" forever. applyAndRecord re-attaches them.
  const missingEdge = swarmyRunsCaddy ? routedServicesMissingEdge(ctx) : [];
  const signature = createHash('sha256')
    .update(JSON.stringify({ config, tasks, missingEdge }))
    .digest('hex');
  if (signature === lastSignature) return { signature, skipped: true, applied: false };

  if (usesInTaskExec(config) && tasks.length === 0) {
    // Deployed but no running task yet (pulling / scheduling) — nothing to
    // apply to. Runtime reads deploying/down from Docker truth meanwhile.
    return { signature: null, skipped: false, applied: false };
  }
  try {
    await applyAndRecord(ctx, config);
    await reissueIntoSealedStore(ctx, config);
    return { signature, skipped: false, applied: true };
  } catch (e) {
    return { signature: null, skipped: false, applied: false, error: errMessage(e) };
  }
}
