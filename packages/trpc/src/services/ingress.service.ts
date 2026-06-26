import {
  applyIngress as applyIngressPkg,
  previewConfig as previewConfigPkg,
  type DriverDispatch,
  type IngressConfig as OrgIngressConfig,
} from '@swarmy/ingress';
import type { IngressStatus, RenderedConfig } from '@swarmy/core/protocol';
import type { TlsMode } from '@swarmy/core';
import type { OrgContext } from '../context';
import { notFound } from '../errors';

export interface IngressConfigView {
  driver: 'caddy' | 'traefik' | 'none';
  enabled: boolean;
  targetNodes: string[];
  domainCount: number;
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
}

interface ConfigRow {
  driver: string;
  enabled: boolean;
  settings: unknown;
  updatedAt: Date;
}

function driverLower(d: string): 'caddy' | 'traefik' | 'none' {
  const v = d.toLowerCase();
  return v === 'caddy' || v === 'traefik' ? v : 'none';
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
  const settings = (row.settings as { targetNodes?: string[]; globalOptions?: Record<string, unknown> }) ?? {};
  const domains = await ctx.db.domain.findMany({
    where: { orgId: ctx.activeOrgId },
    include: { service: { select: { name: true } } },
  });
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
    globalOptions: (settings.globalOptions as OrgIngressConfig['globalOptions']) ?? ({} as OrgIngressConfig['globalOptions']),
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
  const settings = (row.settings as { targetNodes?: string[] }) ?? {};
  const domainCount = await ctx.db.domain.count({ where: { orgId: ctx.activeOrgId } });
  return {
    driver: driverLower(row.driver),
    enabled: row.enabled,
    targetNodes: settings.targetNodes ?? [],
    domainCount,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function setDriver(
  ctx: OrgContext,
  driver: 'caddy' | 'traefik' | 'none',
): Promise<IngressConfigView> {
  await ensureConfig(ctx);
  await ctx.db.ingressConfig.update({
    where: { orgId: ctx.activeOrgId },
    data: { driver: driver.toUpperCase() as 'CADDY' | 'TRAEFIK' | 'NONE' },
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
  }));
}

export async function addDomain(
  ctx: OrgContext,
  input: { host: string; serviceId: string; targetPort: number; tls: TlsMode; pathPrefix?: string },
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
  await reapply(ctx);
  return {
    id: created.id,
    host: created.host,
    serviceId: created.serviceId,
    serviceName: service.name,
    targetPort: created.targetPort,
    tls: input.tls,
    pathPrefix: created.pathPrefix,
  };
}

export async function removeDomain(
  ctx: OrgContext,
  id: string,
): Promise<{ id: string; removed: true }> {
  const domain = await ctx.db.domain.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    select: { id: true },
  });
  if (!domain) throw notFound('domain', id);
  await ctx.db.domain.delete({ where: { id } });
  await reapply(ctx);
  return { id, removed: true };
}

export async function previewConfig(
  ctx: OrgContext,
  driver?: 'caddy' | 'traefik' | 'none',
): Promise<RenderedConfig> {
  const config = await loadOrgConfig(ctx);
  return previewConfigPkg({ ...config, driver: driver ?? config.driver, enabled: true });
}

export function listDrivers(): string[] {
  return ['caddy', 'traefik', 'none'];
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
