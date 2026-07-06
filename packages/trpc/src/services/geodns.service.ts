import { resolve4 } from 'node:dns/promises';
import { REGION_COORDS, regionCoord } from '@swarmy/dns';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { writeAudit } from './audit.service';
import { dispatchNodeLabels } from './node.service';
import {
  composeZone,
  dnsDb,
  listAllIngressHosts,
  collectGeoEndpoints,
} from './dns-snapshot.service';
import {
  ensureDnsService,
  parseDnsOrgSettings,
  removeDnsService,
  type DnsOrgSettings,
} from './dns-deploy.service';
import { composeAndPushDns, type PushResult } from './dns-push.service';
import {
  type ProviderSyncResult,
  type ProviderZoneSnapshot,
  isSyncProvider,
  syncProviderZone,
} from './geodns-provider';

/**
 * Geo-DNS org-level operations ("swarmy is the nameserver" —
 * docs/product/edge-network.md). Zone/record CRUD live in
 * dns-zones.service / dns-records.service; snapshot composition in
 * dns-snapshot.service; deploy + push in dns-deploy/dns-push. This file keeps:
 * the org master switch (+ geoip settings), node regions, the region globe,
 * the dashboard DNS view/diagnostics, and the provider-sync + worker seams.
 */

// ───────────────────────────────────────────── org config ──

export interface GeoDnsConfigView {
  enabled: boolean;
  geoipSource: DnsOrgSettings['geoipSource'];
  maxmindLicenseSecretRef?: string;
  mmdbConfigRef?: string;
  zoneCount: number;
  updatedAt: string;
}

interface GeoDnsConfigRow {
  orgId: string;
  enabled: boolean;
  settings?: unknown;
  updatedAt: Date;
}

function cfgDb(ctx: OrgContext): {
  upsert(args: object): Promise<GeoDnsConfigRow>;
  update(args: object): Promise<GeoDnsConfigRow>;
} {
  return (ctx.db as never as { geoDnsConfig: never }).geoDnsConfig;
}

async function ensureConfig(ctx: OrgContext): Promise<GeoDnsConfigRow> {
  return cfgDb(ctx).upsert({
    where: { orgId: ctx.activeOrgId },
    create: { orgId: ctx.activeOrgId, enabled: false },
    update: {},
  });
}

export async function getConfig(ctx: OrgContext): Promise<GeoDnsConfigView> {
  const cfg = await ensureConfig(ctx);
  const settings = parseDnsOrgSettings(cfg.settings);
  const zones = await dnsDb(ctx).dnsZone.findMany({ where: { orgId: ctx.activeOrgId } });
  return {
    enabled: cfg.enabled,
    geoipSource: settings.geoipSource,
    maxmindLicenseSecretRef: settings.maxmindLicenseSecretRef,
    mmdbConfigRef: settings.mmdbConfigRef,
    zoneCount: zones.length,
    updatedAt: cfg.updatedAt.toISOString(),
  };
}

export async function setConfig(
  ctx: OrgContext,
  input: Partial<Pick<DnsOrgSettings, 'geoipSource' | 'maxmindLicenseSecretRef' | 'mmdbConfigRef'>>,
): Promise<GeoDnsConfigView> {
  const cfg = await ensureConfig(ctx);
  const settings = { ...parseDnsOrgSettings(cfg.settings), ...input };
  await cfgDb(ctx).update({
    where: { orgId: ctx.activeOrgId },
    data: { settings: settings as never },
  });
  // Geoip source changes alter the service spec — reconverge when running.
  if (cfg.enabled) await ensureDnsService(ctx, settings).catch(() => undefined);
  await writeAudit(ctx, {
    action: 'dns.setConfig',
    targetType: 'geoDnsConfig',
    targetId: ctx.activeOrgId,
    metadata: input as Record<string, unknown>,
  });
  return getConfig(ctx);
}

/**
 * Org master switch. Enabling deploys the swarmy-dns global service and pushes
 * the current snapshot; disabling removes the service (zones stay configured).
 */
export async function setEnabled(ctx: OrgContext, enabled: boolean): Promise<GeoDnsConfigView> {
  const cfg = await ensureConfig(ctx);
  await cfgDb(ctx).update({ where: { orgId: ctx.activeOrgId }, data: { enabled } });
  if (enabled) {
    await ensureDnsService(ctx, parseDnsOrgSettings(cfg.settings));
    await composeAndPushDns(ctx).catch(() => undefined);
  } else {
    await removeDnsService(ctx);
  }
  await writeAudit(ctx, {
    action: 'dns.setEnabled',
    targetType: 'geoDnsConfig',
    targetId: ctx.activeOrgId,
    metadata: { enabled },
  });
  return getConfig(ctx);
}

/** Force compose + push + provider sync now (UI "Apply now"). */
export async function applyNow(ctx: OrgContext): Promise<{ summary: string }> {
  const cfg = await ensureConfig(ctx);
  if (!cfg.enabled) return { summary: 'Geo-DNS is disabled — nothing to apply.' };
  await ensureDnsService(ctx, parseDnsOrgSettings(cfg.settings)).catch(() => undefined);
  const push = await composeAndPushDns(ctx);
  const provider = await syncProviderZones(ctx);
  const summary = `pushed ${push.zones} zone(s) to ${push.pushed.length} node(s)` +
    (push.failed.length ? `, ${push.failed.length} failed` : '') +
    (provider.length ? `; provider-synced ${provider.length} zone(s)` : '');
  await writeAudit(ctx, {
    action: 'dns.applyNow',
    targetType: 'geoDnsConfig',
    targetId: ctx.activeOrgId,
    metadata: { summary },
  });
  return { summary };
}

// ───────────────────────────────────────────── node regions ──

/**
 * Set a node's region: writes the `swarmy.region` label and pushes it to the
 * Swarm engine via the existing `updateSwarmNode` (node.update) command.
 */
export async function setNodeRegion(
  ctx: OrgContext,
  nodeId: string,
  region: string,
): Promise<{ id: string; region: string }> {
  // Membership/identity is the DB's job; swarm labels + swarmNodeId are Docker truth (hub).
  const node = await ctx.db.node.findFirst({
    where: { id: nodeId, orgId: ctx.activeOrgId },
    select: { id: true },
  });
  if (!node) throw notFound('node', nodeId);

  // Merge onto the node's live swarm labels (no DB write — labels live in Docker now).
  const labels: Record<string, string> = {
    ...(ctx.hub.nodeInfoFor(nodeId)?.labels ?? {}),
    'swarmy.region': region,
  };

  // Best-effort push to the swarm engine via a manager (reconciles later if offline).
  await dispatchNodeLabels(ctx.hub, ctx.activeOrgId, nodeId, labels);

  await writeAudit(ctx, {
    action: 'geodns.setNodeRegion',
    targetType: 'node',
    targetId: nodeId,
    metadata: { region },
  });
  return { id: nodeId, region };
}

// ───────────────────────────────────────────── region map (globe) ──

/**
 * One region marker for the Infrastructure region map / globe. Coordinates come
 * from the static {@link REGION_COORDS} table (the `swarmy.region` label maps to
 * a lat/lon); membership, health, and outlet count are live swarm truth via the
 * hub — never persisted.
 */
export interface RegionView {
  /** The `swarmy.region` label value. */
  region: string;
  lat: number;
  lng: number;
  /** Controller node ids whose `swarmy.region` label == this region (matches `nodes.list`). */
  nodeIds: string[];
  /** True when at least one node in the region is currently online. */
  healthy: boolean;
  /** How many of this region's nodes carry the outlet role (`swarmy.node.outlet`). */
  outlets: number;
}

/**
 * Region markers for the globe: the canonical {@link REGION_COORDS} set unioned
 * with any custom region labels nodes are actually assigned to, each annotated
 * with live node membership, health, and outlet count. Unplaceable custom
 * labels (no known coordinate) are dropped — the map only shows points it can
 * position.
 */
export function listRegions(ctx: OrgContext): RegionView[] {
  const byRegion = ctx.hub.nodesByRegion(ctx.activeOrgId);
  const outletIds = new Set(ctx.hub.nodesByRole(ctx.activeOrgId, 'outlet'));

  const regions = new Set<string>([...Object.keys(REGION_COORDS), ...byRegion.keys()]);
  const rows: RegionView[] = [];
  for (const region of regions) {
    const coord = regionCoord(region);
    if (!coord) continue;
    const nodeIds = byRegion.get(region) ?? [];
    rows.push({
      region,
      lat: coord.lat,
      lng: coord.lon,
      nodeIds,
      healthy: nodeIds.some((id) => ctx.hub.isOnline(id)),
      outlets: nodeIds.filter((id) => outletIds.has(id)).length,
    });
  }
  return rows.sort((a, b) => (a.region < b.region ? -1 : a.region > b.region ? 1 : 0));
}

// ───────────────────────────────────────────── dashboard DNS view ──

export interface DnsViewRow {
  host: string;
  zone: string;
  source: string;
  /** Docker stack provenance when the host came from a service route. */
  stack?: string;
  endpoints: Array<{ region: string; ip: string; healthy: boolean }>;
  healthyCount: number;
}

/**
 * Live derived-DNS table: every hostname swarmy answers for, its provenance,
 * and the endpoint set behind it. `stack` scopes to one stack's hosts.
 */
export async function listDnsView(ctx: OrgContext, stack?: string): Promise<DnsViewRow[]> {
  const zones = await dnsDb(ctx).dnsZone.findMany({
    where: { orgId: ctx.activeOrgId, mode: 'swarmy-ns' },
    orderBy: { zone: 'asc' },
  });
  const hosts = await listAllIngressHosts(ctx);
  const endpoints = collectGeoEndpoints(ctx);

  const rows: DnsViewRow[] = [];
  for (const zone of zones) {
    const { snapshot } = await composeZone(ctx, zone, { hosts, endpoints });
    for (const record of snapshot.geoRecords) {
      const origin = hosts.find((h) => h.host === record.host);
      if (stack && origin?.stack !== stack) continue;
      rows.push({
        host: record.host,
        zone: zone.zone,
        source: record.source ?? 'route',
        stack: origin?.stack,
        endpoints: record.endpoints.map((e) => ({
          region: e.region,
          ip: e.ip,
          healthy: e.healthy,
        })),
        healthyCount: record.endpoints.filter((e) => e.healthy).length,
      });
    }
  }
  return rows;
}

export interface DomainCheck {
  /** Whether the host resolves publicly to at least one A record right now. */
  resolves: boolean;
  /** IPs swarmy would serve (healthy endpoints; all when none are healthy). */
  expectedIps: string[];
  /** The IP a public resolver actually returns for this host. */
  gotIp: string;
  /** Whether the public answer is one of swarmy's endpoints. */
  served: boolean;
  /** Whether the resolved host answered an HTTP(S) probe. */
  reachable: boolean;
}

async function resolveIps(host: string): Promise<string[]> {
  try {
    return await resolve4(host);
  } catch {
    return [];
  }
}

/** Probe whether the resolved host answers HTTP/HTTPS within a short timeout. */
async function probeReachable(host: string): Promise<boolean> {
  for (const url of [`https://${host}/`, `http://${host}/`]) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2500);
    try {
      await fetch(url, { method: 'HEAD', redirect: 'manual', signal: ctl.signal });
      clearTimeout(timer);
      return true; // any HTTP answer (even an error status) means reachable
    } catch {
      clearTimeout(timer);
    }
  }
  return false;
}

/**
 * Probe one host: what swarmy intends to serve vs what public DNS returns,
 * plus reachability. Diagnostic only — no Docker writes.
 */
export async function checkDomain(ctx: OrgContext, host: string): Promise<DomainCheck> {
  const view = await listDnsView(ctx);
  const row = view.find((r) => r.host === host.toLowerCase().replace(/\.+$/, ''));
  const healthy = row?.endpoints.filter((e) => e.healthy) ?? [];
  const expectedIps = (healthy.length > 0 ? healthy : row?.endpoints ?? []).map((e) => e.ip);
  const gotIp = (await resolveIps(host))[0] ?? '';
  return {
    resolves: gotIp !== '',
    expectedIps,
    gotIp,
    served: gotIp !== '' && expectedIps.includes(gotIp),
    reachable: gotIp ? await probeReachable(host) : false,
  };
}

// ───────────────────────────────────────────── provider sync ──

/**
 * Resolve the provider API token from the controller's secret-injected ENV
 * (never the DB). `tokenEnv` names the var; per-provider defaults apply.
 * Route53 assembles `accessKeyId:secretAccessKey[:sessionToken]` from the
 * standard AWS vars when no single var is named.
 */
export function resolveProviderToken(provider: string, tokenEnv?: string): string | null {
  const env = (k?: string): string | undefined => (k ? process.env[k] : undefined);
  if (provider === 'cloudflare') {
    return env(tokenEnv) ?? env('CLOUDFLARE_API_TOKEN') ?? null;
  }
  if (provider === 'route53') {
    const single = env(tokenEnv);
    if (single) return single;
    const id = env('AWS_ACCESS_KEY_ID');
    const secret = env('AWS_SECRET_ACCESS_KEY');
    if (id && secret) {
      const sessionToken = env('AWS_SESSION_TOKEN');
      return sessionToken ? `${id}:${secret}:${sessionToken}` : `${id}:${secret}`;
    }
    return null;
  }
  return null;
}

/**
 * Mirror enabled cloudflare/route53 zones into their providers, fed from the
 * SAME composed snapshots as swarmy-ns zones (one truth, two delivery
 * mechanisms). Best-effort per zone.
 */
export async function syncProviderZones(ctx: OrgContext): Promise<ProviderSyncResult[]> {
  const zones = await dnsDb(ctx).dnsZone.findMany({
    where: { orgId: ctx.activeOrgId, enabled: true, mode: { in: ['cloudflare', 'route53'] } },
  });
  const results: ProviderSyncResult[] = [];
  for (const zone of zones) {
    if (!isSyncProvider(zone.mode)) continue;
    const settings =
      zone.settings && typeof zone.settings === 'object'
        ? (zone.settings as Record<string, unknown>)
        : {};
    const zoneId = typeof settings.providerZoneId === 'string' ? settings.providerZoneId : '';
    if (!zoneId) continue;
    const token = resolveProviderToken(
      zone.mode,
      typeof settings.providerTokenEnv === 'string' ? settings.providerTokenEnv : undefined,
    );
    if (!token) continue;

    const { snapshot } = await composeZone(ctx, zone);
    const providerSnapshot: ProviderZoneSnapshot = {
      zone: snapshot.zone,
      ttl: snapshot.ttl,
      endpoints: snapshot.geoRecords.flatMap((record) =>
        record.endpoints.map((e) => ({
          host: record.host,
          region: e.region,
          target: e.ip,
          healthy: e.healthy,
        })),
      ),
    };
    const result = await syncProviderZone(zone.mode, providerSnapshot, {
      zoneId,
      token,
      region: typeof settings.providerRegion === 'string' ? settings.providerRegion : undefined,
    });
    results.push(result);
    await writeAudit(ctx, {
      action: 'geodns.providerSync',
      targetType: 'dnsZone',
      targetId: zone.id,
      metadata: {
        provider: result.provider,
        applied: result.applied,
        planned: result.planned.length,
        errors: result.errors.length,
      },
    });
  }
  return results;
}

// ───────────────────────────────────────────── worker seam ──

export interface DnsReconcileDeps {
  db: OrgContext['db'];
  hub: OrgContext['hub'];
  orgId: string;
  /** Per-node last-acked bundle signatures — nodes not at the current signature
   *  get (re)pushed every tick until they ack (new nodes, failed applies). */
  acked?: ReadonlyMap<string, string>;
  /** Converge the swarmy-dns service too (heavier — run every Nth tick). */
  converge?: boolean;
}

/**
 * Worker entry (apps/api dns-reconcile): compose → signature-gate → push →
 * provider sync. Imports ONLY root-exported functions — the pure logic lives
 * in @swarmy/dns, shared with the server; nothing is inlined (the v1 drift
 * bug this rework kills).
 */
export async function reconcileDnsOrg(
  deps: DnsReconcileDeps,
): Promise<{ push: PushResult; providerSynced: number }> {
  const ctx = {
    db: deps.db,
    hub: deps.hub,
    activeOrgId: deps.orgId,
    // System context: no session/user. writeAudit tolerates it (system actor).
    session: null,
    user: null,
    membership: { role: 'admin', orgId: deps.orgId },
  } as unknown as OrgContext;

  const cfg = await ensureConfig(ctx);
  if (!cfg.enabled) {
    return {
      push: { signature: '', zones: 0, pushed: [], failed: [], skipped: true },
      providerSynced: 0,
    };
  }
  if (deps.converge) {
    // Converge failures must be visible — a swallowed deploy error looks like
    // "enabled but no nameservers anywhere" with nothing in the logs.
    await ensureDnsService(ctx, parseDnsOrgSettings(cfg.settings)).catch((err) => {
      console.warn(
        `[dns-reconcile] org=${deps.orgId} swarmy-dns converge failed:`,
        err instanceof Error ? err.message : err,
      );
    });
  }
  const push = await composeAndPushDns(ctx, deps.acked);
  // Provider zones ride the same gate: unchanged content → no API calls.
  const providerSynced = push.skipped ? 0 : (await syncProviderZones(ctx).catch(() => [])).length;
  return { push, providerSynced };
}
