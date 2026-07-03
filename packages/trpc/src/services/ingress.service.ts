import {
  applyIngress as applyIngressPkg,
  previewConfig as previewConfigPkg,
  type ColdRoute,
  type ControllerVhost,
  type DriverDispatch,
  type HaStorage,
  type IngressConfig as OrgIngressConfig,
  type RouteProtection,
  type TunnelOptions,
} from '@swarmy/ingress';
import type { IngressStatus, RenderedConfig } from '@swarmy/core/protocol';
import { buildInventory, type TlsMode } from '@swarmy/core';
import { decryptSecret, encryptSecret } from '@swarmy/core/crypto';
import type { Auth } from '@swarmy/auth';
import type { DB } from '@swarmy/db';
import type { AgentHub } from '../hub/types';
import type { OrgContext } from '../context';
import { systemContext } from './cicd.service';
import { writeAudit } from '../services/audit.service';
import { notFound } from '../errors';
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
 * so the controller can wake the service and 307 the caller back. On a single-node
 * Docker Desktop swarm `host.docker.internal` resolves to the host (the controller)
 * from inside the ingress container. Overridable for multi-host / non-default ports.
 */
function activatorBaseUrl(): string {
  return process.env.SWARMY_ACTIVATOR_URL ?? 'http://host.docker.internal:3001';
}

/** Activator dial target `host:port` (path stripped — the wake path is per-service). */
function activatorUpstream(): string {
  try {
    return new URL(activatorBaseUrl()).host;
  } catch {
    return 'host.docker.internal:3001';
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
function computeColdRoutes(ctx: OrgContext): Map<string, ColdRoute> {
  const cold = new Map<string, ColdRoute>();
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const upstream = activatorUpstream();
  for (const s of buildInventory(services, containers).services) {
    if (s.scaleToZero && s.replicas.running === 0) {
      cold.set(s.name, { upstream, wakePath: `/_wake/${encodeURIComponent(s.name)}` });
    }
  }
  return cold;
}

/**
 * Driver ids supported at the controller. `cloudflared` is the Cloudflare Tunnel
 * (no-public-IP) driver added by the ingress-strategy epic.
 */
export type IngressDriverId = 'caddy' | 'traefik' | 'none' | 'cloudflared' | 'nginx' | 'haproxy';

/** Map a controller driver id ⇄ Prisma `IngressDriver` enum value. */
type IngressDriverEnum =
  | 'CADDY'
  | 'TRAEFIK'
  | 'NONE'
  | 'CLOUDFLARE_TUNNEL'
  | 'NGINX'
  | 'HAPROXY';
const DRIVER_TO_ENUM: Record<IngressDriverId, IngressDriverEnum> = {
  caddy: 'CADDY',
  traefik: 'TRAEFIK',
  none: 'NONE',
  cloudflared: 'CLOUDFLARE_TUNNEL',
  nginx: 'NGINX',
  haproxy: 'HAPROXY',
};

export interface IngressConfigView {
  driver: IngressDriverId;
  enabled: boolean;
  targetNodes: string[];
  domainCount: number;
  /** Whether Caddy HA shared-storage is configured (secrets never returned). */
  haConfigured: boolean;
  /** Whether a Cloudflare tunnel is configured (secrets never returned). */
  tunnelConfigured: boolean;
  /** Custom ingress-controller image (null = the stock caddy:2-alpine). */
  controllerImage: string | null;
  updatedAt: string;
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
}

interface ConfigRow {
  driver: string;
  enabled: boolean;
  settings: unknown;
  updatedAt: Date;
}

function driverLower(d: string): IngressDriverId {
  switch (d.toUpperCase()) {
    case 'CADDY':
      return 'caddy';
    case 'TRAEFIK':
      return 'traefik';
    case 'CLOUDFLARE_TUNNEL':
      return 'cloudflared';
    case 'NGINX':
      return 'nginx';
    case 'HAPROXY':
      return 'haproxy';
    default:
      return 'none';
  }
}

/**
 * Shape persisted in `IngressConfig.settings` (Json). Secret fields hold encrypted
 * vault blobs — never plaintext. They are decrypted just-in-time when building the
 * driver config for render/dispatch and are NEVER returned to the client.
 */
interface IngressSettings {
  targetNodes?: string[];
  globalOptions?: Record<string, unknown>;
  /**
   * Ingress-controller image `ensureCaddyController` deploys. Unset = the stock
   * caddy:2-alpine. Set to the swarmy build (docker/caddy-swarmy) to enable
   * per-route rate limits (mholt/caddy-ratelimit is compiled in).
   */
  controllerImage?: string;
  /** Caddy HA Redis coords (non-secret) + encrypted secret refs. */
  haStorage?: {
    host: string;
    port?: number;
    db?: number;
    keyPrefix?: string;
    tlsEnabled?: boolean;
    username?: string;
    /** encrypted */
    passwordEnc?: string;
    /** encrypted */
    encryptionKeyEnc?: string;
  };
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

function readSettings(row: ConfigRow): IngressSettings {
  return (row.settings as IngressSettings | null) ?? {};
}

/** Resolve persisted HA settings into the render-time {@link HaStorage} (decrypts). */
function resolveHaStorage(s: IngressSettings): HaStorage | undefined {
  const ha = s.haStorage;
  if (!ha) return undefined;
  return {
    host: ha.host,
    port: ha.port ?? 6379,
    db: ha.db ?? 0,
    keyPrefix: ha.keyPrefix ?? 'caddy',
    tlsEnabled: ha.tlsEnabled ?? false,
    username: ha.username,
    password: ha.passwordEnc ? decryptSecret(ha.passwordEnc) : undefined,
    encryptionKey: ha.encryptionKeyEnc ? decryptSecret(ha.encryptionKeyEnc) : undefined,
  };
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

async function ensureConfig(ctx: OrgContext): Promise<ConfigRow> {
  return ctx.db.ingressConfig.upsert({
    where: { orgId: ctx.activeOrgId },
    create: { orgId: ctx.activeOrgId, driver: 'NONE', enabled: false },
    update: {},
  });
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

async function computeControllerVhosts(ctx: OrgContext): Promise<ControllerVhost[]> {
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

async function loadOrgConfig(ctx: OrgContext): Promise<OrgIngressConfig> {
  const row = await ensureConfig(ctx);
  const settings = readSettings(row);
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
  if (settings.controllerImage) extraConfig.controllerImage = settings.controllerImage;
  // Observability on ⇒ render the `tracing` directive so the edge emits a span
  // per request (the controller carries the matching OTLP exporter env).
  const obs = await ctx.db.observabilityConfig.findUnique({
    where: { orgId: ctx.activeOrgId },
    select: { enabled: true },
  });
  const tracing = obs?.enabled === true;
  return {
    driver: driverLower(row.driver),
    enabled: row.enabled,
    orgId: ctx.activeOrgId,
    targetNodes: settings.targetNodes ?? [],
    domains: serviceRoutes.map(({ serviceName, route }) => ({
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
    })),
    // Controller-upstream vhosts (status-page / webhook domains) — persisted rows
    // resolved at render time onto the controller upstream.
    controllerVhosts: await computeControllerVhosts(ctx),
    globalOptions: {
      ...baseGlobal,
      extraConfig,
      tracing,
      // Promote the load-bearing (encrypted) options, resolving secrets JIT.
      haStorage: resolveHaStorage(settings),
      tunnel: resolveTunnel(settings),
    },
  };
}

function makeDispatch(ctx: OrgContext): DriverDispatch {
  return {
    async resolveTargetNodes(orgId, explicit) {
      if (explicit.length) return explicit;
      // Prefer nodes tagged as the ingress (edge) tier via the node-role label;
      // fall back to the manager set when no node is marked so ingress still applies.
      const marked = await ingressTargetNodes(ctx);
      return marked.length ? marked : ctx.hub.managerNodes(orgId);
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
    haConfigured: Boolean(settings.haStorage),
    tunnelConfigured: Boolean(settings.tunnel?.tunnelId),
    controllerImage: settings.controllerImage ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The configured controller image, or null for the stock default. */
export async function getControllerImage(ctx: OrgContext): Promise<string | null> {
  const row = await ensureConfig(ctx);
  return readSettings(row).controllerImage ?? null;
}

/**
 * Set (or clear) the ingress-controller image. Persisted in settings; the next
 * `ensureController` deploy converges the running controller onto it. Needed for
 * per-route rate limits — the stock caddy:2-alpine lacks mholt/caddy-ratelimit.
 */
export async function setControllerImage(
  ctx: OrgContext,
  image: string | null,
): Promise<IngressConfigView> {
  await patchSettings(ctx, (s) => ({ ...s, controllerImage: image ?? undefined }));
  await writeAudit(ctx, {
    action: image ? 'ingress.setControllerImage' : 'ingress.clearControllerImage',
    targetType: 'ingressConfig',
    targetId: ctx.activeOrgId,
    metadata: { image },
  });
  return getConfig(ctx);
}

/**
 * Set the ingress controller's target node set — the swarm node ids
 * `ensureController`-class deploys should prefer. Persisted in settings
 * (`IngressConfigView.targetNodes`); an empty array clears the pin and falls
 * back to the default placement heuristic (`swarmy.node.ingress` label /
 * manager quorum, see `ingress-controller.ts`).
 */
export async function setTargetNodes(
  ctx: OrgContext,
  nodeIds: string[],
): Promise<IngressConfigView> {
  await patchSettings(ctx, (s) => ({ ...s, targetNodes: nodeIds }));
  await writeAudit(ctx, {
    action: 'ingress.setTargetNodes',
    targetType: 'ingressConfig',
    targetId: ctx.activeOrgId,
    metadata: { nodeIds },
  });
  return getConfig(ctx);
}

export async function setDriver(
  ctx: OrgContext,
  driver: IngressDriverId,
): Promise<IngressConfigView> {
  await ensureConfig(ctx);
  await ctx.db.ingressConfig.update({
    where: { orgId: ctx.activeOrgId },
    // NGINX/HAPROXY are valid only after the IngressDriver enum migration lands
    // (see INTEGRATION); cast keeps the build green until then.
    data: { driver: DRIVER_TO_ENUM[driver] as never },
  });
  await writeAudit(ctx, {
    action: 'ingress.setDriver',
    targetType: 'ingressConfig',
    targetId: ctx.activeOrgId,
    metadata: { driver },
  });
  await reapply(ctx);
  return getConfig(ctx);
}

/** Merge a partial patch into the persisted settings JSON. */
async function patchSettings(
  ctx: OrgContext,
  patch: (s: IngressSettings) => IngressSettings,
): Promise<void> {
  const row = await ensureConfig(ctx);
  const next = patch(readSettings(row));
  await ctx.db.ingressConfig.update({
    where: { orgId: ctx.activeOrgId },
    data: { settings: next as object },
  });
}

/**
 * Configure (or clear) Caddy HA shared-cert storage. Secrets are encrypted at
 * rest via the credential vault; only non-secret coords are stored in the clear.
 */
export async function setHaStorage(
  ctx: OrgContext,
  input:
    | {
        host: string;
        port?: number;
        db?: number;
        keyPrefix?: string;
        tlsEnabled?: boolean;
        username?: string;
        password?: string;
        encryptionKey?: string;
      }
    | null,
): Promise<IngressConfigView> {
  await patchSettings(ctx, (s) => ({
    ...s,
    haStorage: input
      ? {
          host: input.host,
          port: input.port ?? 6379,
          db: input.db ?? 0,
          keyPrefix: input.keyPrefix ?? `caddy_${ctx.activeOrgId}`,
          tlsEnabled: input.tlsEnabled ?? false,
          username: input.username,
          passwordEnc: input.password ? encryptSecret(input.password) : undefined,
          encryptionKeyEnc: input.encryptionKey ? encryptSecret(input.encryptionKey) : undefined,
        }
      : undefined,
  }));
  await writeAudit(ctx, {
    action: input ? 'ingress.setHaStorage' : 'ingress.clearHaStorage',
    targetType: 'ingressConfig',
    targetId: ctx.activeOrgId,
    metadata: { host: input?.host ?? null },
  });
  await reapply(ctx);
  return getConfig(ctx);
}

/** Toggle on-demand TLS + record the controller `ask` endpoint. */
export async function setOnDemandTls(
  ctx: OrgContext,
  input: { enabled: boolean; askUrl?: string },
): Promise<IngressConfigView> {
  await patchSettings(ctx, (s) => {
    const globalOptions = { ...(s.globalOptions ?? {}) } as Record<string, unknown>;
    globalOptions.onDemandTls = input.enabled;
    const extra = { ...((globalOptions.extraConfig as Record<string, unknown>) ?? {}) };
    if (input.askUrl) extra.onDemandAsk = input.askUrl;
    globalOptions.extraConfig = extra;
    return { ...s, globalOptions };
  });
  await writeAudit(ctx, {
    action: 'ingress.setOnDemandTls',
    targetType: 'ingressConfig',
    targetId: ctx.activeOrgId,
    metadata: { enabled: input.enabled },
  });
  await reapply(ctx);
  return getConfig(ctx);
}

/**
 * Configure (or clear) the Cloudflare tunnel. The pasted CF API token and the
 * run token / credentials JSON are encrypted at rest; only coords are in clear.
 * (Tunnel *creation* via the CF API happens controller-side — see INTEGRATION —
 * which then calls this with the resulting tunnelId + tokens.)
 */
export async function setTunnel(
  ctx: OrgContext,
  input:
    | {
        accountId?: string;
        tunnelId?: string;
        tunnelName?: string;
        image?: string;
        replicas?: number;
        metricsAddr?: string;
        apiToken?: string;
        runToken?: string;
        credentialsJson?: string;
      }
    | null,
): Promise<IngressConfigView> {
  await patchSettings(ctx, (s) => ({
    ...s,
    tunnel: input
      ? {
          ...s.tunnel,
          provider: 'cloudflare',
          accountId: input.accountId ?? s.tunnel?.accountId,
          tunnelId: input.tunnelId ?? s.tunnel?.tunnelId,
          tunnelName: input.tunnelName ?? s.tunnel?.tunnelName ?? 'swarmy',
          image: input.image ?? s.tunnel?.image,
          replicas: input.replicas ?? s.tunnel?.replicas,
          metricsAddr: input.metricsAddr ?? s.tunnel?.metricsAddr,
          apiTokenEnc: input.apiToken ? encryptSecret(input.apiToken) : s.tunnel?.apiTokenEnc,
          runTokenEnc: input.runToken ? encryptSecret(input.runToken) : s.tunnel?.runTokenEnc,
          credentialsJsonEnc: input.credentialsJson
            ? encryptSecret(input.credentialsJson)
            : s.tunnel?.credentialsJsonEnc,
        }
      : undefined,
  }));
  await writeAudit(ctx, {
    action: input ? 'ingress.setTunnel' : 'ingress.clearTunnel',
    targetType: 'ingressConfig',
    targetId: ctx.activeOrgId,
    metadata: { tunnelId: input?.tunnelId ?? null },
  });
  await reapply(ctx);
  return getConfig(ctx);
}

export async function setEnabled(ctx: OrgContext, enabled: boolean): Promise<IngressConfigView> {
  await ensureConfig(ctx);
  await ctx.db.ingressConfig.update({ where: { orgId: ctx.activeOrgId }, data: { enabled } });
  await reapply(ctx);
  return getConfig(ctx);
}

export async function listDomains(ctx: OrgContext, stack?: string): Promise<DomainView[]> {
  // Routes are Docker-truth: project each service's `swarmy.ingress.routes` label.
  // The DomainView id is `${serviceId}:${host}` (the handle removeDomain parses back).
  // `stack` scopes the list to services in that Docker stack (namespace label).
  return listRoutesForOrg(ctx)
    .filter((r) => !stack || r.stack === stack)
    .map(({ serviceId, serviceName, stack: svcStack, route }) => ({
      id: `${serviceId}:${route.host}`,
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
    }));
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
  },
): Promise<DomainView> {
  // Resolve the target from live Docker inventory (no Service table). The route is
  // persisted on the service's `swarmy.ingress.routes` label — Docker is the truth.
  const service = resolveLiveService(ctx, input.serviceId);
  if (!service) throw notFound('service', input.serviceId);

  // Read the service's current routes, drop any existing route for this host, then
  // append the new one and write the whole array back as the label value.
  const routes = readRoutes(service.labels).filter((r) => r.host !== input.host);
  const route: Route = { host: input.host, port: input.targetPort, tls: tlsModeToRouteTls(input.tls) };
  if (input.pathPrefix) route.path = input.pathPrefix;
  if (input.ingressDriver) route.driver = input.ingressDriver;
  routes.push(route);

  // The label IS the source of truth, so this dispatch must land (not best-effort).
  // `swarmy.ingress` is kept in sync so the service-summary ingress indicator stays lit.
  const node = await resolveManagerNode(ctx);
  await ctx.hub.dispatch(node.id, 'service.updateLabels', {
    service: service.name,
    add: { [INGRESS_ROUTES_LABEL]: serializeRoutes(routes), [INGRESS_ENABLED_LABEL]: 'true' },
    removeKeys: [],
  });

  await reapply(ctx);
  return {
    id: `${service.id}:${input.host}`,
    host: input.host,
    serviceId: service.id,
    serviceName: service.name,
    stack: service.stack,
    targetPort: input.targetPort,
    tls: input.tls,
    pathPrefix: input.pathPrefix ?? null,
    ingressDriver: input.ingressDriver ?? null,
    protection: null,
    canaryPct: null,
  };
}

export async function removeDomain(
  ctx: OrgContext,
  id: string,
): Promise<{ id: string; removed: true }> {
  // The DomainView id is `${serviceId}:${host}`; split on the FIRST colon (service
  // ids are colon-free, hosts may not be — keep everything after it as the host).
  const sep = id.indexOf(':');
  const serviceId = sep >= 0 ? id.slice(0, sep) : id;
  const host = sep >= 0 ? id.slice(sep + 1) : '';
  const service = resolveLiveService(ctx, serviceId);
  if (!service) throw notFound('domain', id);

  const remaining = readRoutes(service.labels).filter((r) => r.host !== host);
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

export async function previewConfig(
  ctx: OrgContext,
  driver?: IngressDriverId,
): Promise<RenderedConfig> {
  const config = await loadOrgConfig(ctx);
  return previewConfigPkg({ ...config, driver: driver ?? config.driver, enabled: true });
}

export function listDrivers(): IngressDriverId[] {
  return ['none', 'caddy', 'traefik', 'cloudflared', 'nginx', 'haproxy'];
}

/** Render + dispatch the current config to the ingress nodes (best-effort). */
async function reapply(ctx: OrgContext): Promise<IngressStatus | null> {
  const config = await loadOrgConfig(ctx);
  if (config.driver === 'none' || !config.enabled) return null;
  try {
    return await applyIngressPkg(config, makeDispatch(ctx));
  } catch {
    return null;
  }
}

export async function applyNow(ctx: OrgContext): Promise<IngressStatus> {
  const config = await loadOrgConfig(ctx);
  return applyIngressPkg(config, makeDispatch(ctx));
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
export async function reapplyIngressForOrg(
  deps: IngressColdReconcileDeps,
  orgId: string,
): Promise<void> {
  const ctx = systemContext(deps, orgId);
  const config = await loadOrgConfig(ctx);
  if (config.driver === 'none' || !config.enabled) return;
  await applyIngressPkg(config, makeDispatch(ctx)).catch(() => undefined);
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
    await applyIngressPkg(config, makeDispatch(ctx));
    return coldHosts;
  } catch {
    // Apply failed — return the PREVIOUS set so the caller's cache is unchanged and
    // the (still-differing) cold set re-triggers a dispatch on the next tick.
    return [...prevColdHosts];
  }
}
