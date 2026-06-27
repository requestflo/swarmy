import {
  applyIngress as applyIngressPkg,
  previewConfig as previewConfigPkg,
  type DriverDispatch,
  type HaStorage,
  type IngressConfig as OrgIngressConfig,
  type TunnelOptions,
} from '@swarmy/ingress';
import type { IngressStatus, RenderedConfig } from '@swarmy/core/protocol';
import { type TlsMode } from '@swarmy/core';
import { decryptSecret, encryptSecret } from '@swarmy/core/crypto';
import type { OrgContext } from '../context';
import { writeAudit } from '../services/audit.service';
import { notFound } from '../errors';

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
  updatedAt: string;
}

export interface DomainView {
  id: string;
  host: string;
  serviceId: string;
  serviceName: string;
  targetPort: number;
  tls: TlsMode;
  pathPrefix: string | null;
  /** Per-domain driver override (null = inherit org default). */
  ingressDriver: IngressDriverId | null;
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
   * Per-domain driver overrides keyed by host (additive per-stack/per-domain
   * selection). Resolution: domainDrivers[host] → org default. Promoted to
   * Domain.ingressDriver in a future migration (see INTEGRATION).
   */
  domainDrivers?: Record<string, IngressDriverId>;
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

async function loadOrgConfig(ctx: OrgContext): Promise<OrgIngressConfig> {
  const row = await ensureConfig(ctx);
  const settings = readSettings(row);
  const domains = await ctx.db.domain.findMany({
    where: { orgId: ctx.activeOrgId },
    include: { service: { select: { name: true } } },
  });
  const baseGlobal = (settings.globalOptions as OrgIngressConfig['globalOptions']) ?? ({} as OrgIngressConfig['globalOptions']);
  return {
    driver: driverLower(row.driver),
    enabled: row.enabled,
    orgId: ctx.activeOrgId,
    targetNodes: settings.targetNodes ?? [],
    domains: domains.map((d) => ({
      domain: d.host,
      pathPrefix: d.pathPrefix ?? '/',
      service: d.service.name,
      port: d.targetPort,
      tls: (d.tlsMode as TlsMode) ?? 'auto',
      stripPathPrefix: d.stripPathPrefix,
      middlewares: (d.middlewares as string[]) ?? [],
    })),
    globalOptions: {
      ...baseGlobal,
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
      const managers = await ctx.db.node.findMany({
        where: { orgId, role: 'MANAGER' },
        select: { id: true },
      });
      return managers.filter((m) => ctx.hub.isOnline(m.id)).map((m) => m.id);
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
  const domainCount = await ctx.db.domain.count({ where: { orgId: ctx.activeOrgId } });
  return {
    driver: driverLower(row.driver),
    enabled: row.enabled,
    targetNodes: settings.targetNodes ?? [],
    domainCount,
    haConfigured: Boolean(settings.haStorage),
    tunnelConfigured: Boolean(settings.tunnel?.tunnelId),
    updatedAt: row.updatedAt.toISOString(),
  };
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

export async function listDomains(ctx: OrgContext): Promise<DomainView[]> {
  const row = await ensureConfig(ctx);
  const overrides = readSettings(row).domainDrivers ?? {};
  const domains = await ctx.db.domain.findMany({
    where: { orgId: ctx.activeOrgId },
    include: { service: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return domains.map((d) => ({
    id: d.id,
    host: d.host,
    serviceId: d.serviceId,
    serviceName: d.service.name,
    targetPort: d.targetPort,
    tls: (d.tlsMode as TlsMode) ?? 'auto',
    pathPrefix: d.pathPrefix,
    ingressDriver: overrides[d.host] ?? null,
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
  const service = await ctx.db.service.findFirst({
    where: { id: input.serviceId, orgId: ctx.activeOrgId },
    select: { id: true, name: true },
  });
  if (!service) throw notFound('service', input.serviceId);
  const created = await ctx.db.domain.create({
    data: {
      orgId: ctx.activeOrgId,
      host: input.host,
      serviceId: input.serviceId,
      targetPort: input.targetPort,
      tlsMode: input.tls,
      pathPrefix: input.pathPrefix ?? null,
    },
  });
  await ctx.db.service.update({ where: { id: service.id }, data: { ingressEnabled: true } });
  // Per-domain driver override (until Domain.ingressDriver lands — see INTEGRATION).
  if (input.ingressDriver) {
    await patchSettings(ctx, (s) => ({
      ...s,
      domainDrivers: { ...(s.domainDrivers ?? {}), [input.host]: input.ingressDriver! },
    }));
  }
  await reapply(ctx);
  return {
    id: created.id,
    host: created.host,
    serviceId: created.serviceId,
    serviceName: service.name,
    targetPort: created.targetPort,
    tls: input.tls,
    pathPrefix: created.pathPrefix,
    ingressDriver: input.ingressDriver ?? null,
  };
}

export async function removeDomain(
  ctx: OrgContext,
  id: string,
): Promise<{ id: string; removed: true }> {
  const domain = await ctx.db.domain.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    select: { id: true, host: true },
  });
  if (!domain) throw notFound('domain', id);
  await ctx.db.domain.delete({ where: { id } });
  // Drop any per-domain driver override for the removed host.
  await patchSettings(ctx, (s) => {
    if (!s.domainDrivers?.[domain.host]) return s;
    const next = { ...s.domainDrivers };
    delete next[domain.host];
    return { ...s, domainDrivers: next };
  });
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
