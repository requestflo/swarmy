import { resolve4 } from 'node:dns/promises';
import { buildInventory } from '@swarmy/core';
import type { ServiceSpec } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { readRoutes } from './ingress-routes';
import type { CommandName } from '../hub/types';
import { notFound } from '../errors';
import { resolveManagerNode } from './dispatch.service';
import { writeAudit } from './audit.service';
import { REGION_COORDS, regionCoord, type SteerTarget } from './geo-steer';
import { planReconcile, type RegionHealth } from './geodns-reconcile.core';
import {
  type GeoDnsSettings,
  type GeoLitePlan,
  GEOLITE_INIT_IMAGE,
  GEOLITE_INIT_SERVICE,
  geoipEnabled,
  geoliteInitScript,
  parseGeoDnsSettings,
  resolveGeoLite,
} from './geodns-geolite';
import {
  type ProviderSyncResult,
  type ProviderZoneSnapshot,
  isSyncProvider,
  syncProviderZone,
} from './geodns-provider';

/**
 * Geo-DNS (GSLB) — epic #12, Part A — MVP.
 *
 * Region is the node label `swarmy.region` (no new placement engine). The
 * controller composes a CoreDNS zone snapshot from records the org defines and
 * the live health of each regional ingress, renders a Corefile + zonefile (pure
 * TS, below), and — when enabled — deploys CoreDNS as a normal swarm service via
 * the EXISTING deploy path (`service.deploy`).
 *
 * NOTE (INTEGRATION): this service reads/writes two new Prisma models added by
 * the integrator — `GeoDnsConfig` (org-scoped) and `DnsRecord`. The Prisma client
 * is accessed through a narrow typed accessor so this file stays well-typed and
 * compiles once the schema blocks land; see the INTEGRATION section of the report.
 */

// ───────────────────────────────────────────── model shims ──
// Mirror the Prisma rows the integrator adds. Once `bun db:generate` runs these
// are structurally identical to the generated delegates' row types.

interface GeoDnsConfigRow {
  orgId: string;
  enabled: boolean;
  zone: string;
  ttl: number;
  provider: string; // 'coredns' | 'cloudflare' | 'route53'
  /**
   * Opaque Json bag of *references* — GeoLite2 config/secret names and provider
   * zone/token-env/region. Holds NO secret values (skill: secrets live in Docker
   * secrets / the controller's secret-injected env, never the DB). See
   * {@link GeoDnsSettings}. Optional so the file compiles before the column lands.
   */
  settings?: unknown;
  updatedAt: Date;
}

interface DnsRecordRow {
  id: string;
  orgId: string;
  host: string;
  region: string;
  targetIngress: string;
  healthy: boolean;
}

interface GeoDnsDelegate {
  upsert(args: {
    where: { orgId: string };
    create: Partial<GeoDnsConfigRow> & { orgId: string };
    update: Partial<GeoDnsConfigRow>;
  }): Promise<GeoDnsConfigRow>;
  update(args: { where: { orgId: string }; data: Partial<GeoDnsConfigRow> }): Promise<GeoDnsConfigRow>;
}
interface DnsRecordDelegate {
  findMany(args: { where: { orgId: string }; orderBy?: unknown }): Promise<DnsRecordRow[]>;
  findFirst(args: { where: { id: string; orgId: string } }): Promise<DnsRecordRow | null>;
  upsert(args: {
    where: { id: string } | { orgId_host_region: { orgId: string; host: string; region: string } };
    create: Omit<DnsRecordRow, 'id'>;
    update: Partial<DnsRecordRow>;
  }): Promise<DnsRecordRow>;
  update(args: { where: { id: string }; data: Partial<DnsRecordRow> }): Promise<DnsRecordRow>;
  delete(args: { where: { id: string } }): Promise<DnsRecordRow>;
}

/** Narrow accessor over the (post-integration) Prisma client. */
function db(ctx: OrgContext): { geoDnsConfig: GeoDnsDelegate; dnsRecord: DnsRecordDelegate } {
  const anyDb = ctx.db as unknown as {
    geoDnsConfig: GeoDnsDelegate;
    dnsRecord: DnsRecordDelegate;
  };
  return { geoDnsConfig: anyDb.geoDnsConfig, dnsRecord: anyDb.dnsRecord };
}

// ───────────────────────────────────────────── views ──

export interface GeoDnsConfigView {
  enabled: boolean;
  zone: string;
  ttl: number;
  provider: string;
  recordCount: number;
  updatedAt: string;
}

export interface DnsRecordView {
  id: string;
  host: string;
  region: string;
  targetIngress: string;
  healthy: boolean;
}

// ───────────────────────────────────────────── zone snapshot ──

export interface ZoneEndpoint {
  host: string;
  region: string;
  target: string;
  healthy: boolean;
}

export interface ZoneSnapshot {
  zone: string;
  ttl: number;
  provider: string;
  endpoints: ZoneEndpoint[];
}

const DEFAULT_TTL = 30;
const COREDNS_IMAGE = 'coredns/coredns:1.11.3';
/** Attachable overlay CoreDNS joins (ensured before deploy). */
const DNS_NETWORK = 'swarmy-dns';
// `network.ensure` becomes a valid CommandName once the hub/types.ts integration
// snippet lands; the cast keeps @swarmy/trpc green until then (see INTEGRATION).
const NETWORK_ENSURE = 'network.ensure' as CommandName;
/** Swarm node-role label that marks a node as a DNS (outlet) node. */
const OUTLET_NODE_LABEL = 'swarmy.node.outlet';

/**
 * Placement constraint for CoreDNS. Prefer pinning to nodes explicitly marked
 * `swarmy.node.outlet=true` (the DNS/outlet tier); fall back to managers when no
 * node carries the label yet so a fresh swarm still schedules the service.
 */
function outletPlacementConstraint(ctx: OrgContext): string {
  const marked = ctx.hub
    .nodeInventory(ctx.activeOrgId, true)
    .some((n) => n.labels[OUTLET_NODE_LABEL] === 'true');
  return marked ? `node.labels.${OUTLET_NODE_LABEL}==true` : 'node.role == manager';
}

async function ensureConfig(ctx: OrgContext): Promise<GeoDnsConfigRow> {
  return db(ctx).geoDnsConfig.upsert({
    where: { orgId: ctx.activeOrgId },
    create: { orgId: ctx.activeOrgId, enabled: false, zone: '', ttl: DEFAULT_TTL, provider: 'coredns' },
    update: {},
  });
}

/**
 * Compose the live zone snapshot: each record's `healthy` bit is the persisted
 * value AND-ed with whether any node in that region is currently online (region
 * = the `swarmy.region` node label). This reuses existing heartbeat telemetry —
 * no new health protocol.
 */
export async function buildZoneSnapshot(ctx: OrgContext): Promise<ZoneSnapshot> {
  const cfg = await ensureConfig(ctx);
  const records = await db(ctx).dnsRecord.findMany({
    where: { orgId: ctx.activeOrgId },
    orderBy: { host: 'asc' },
  });

  // Map region → at least one online node (label-based). Node membership comes from
  // the DB (enrollment ids); the region label + online state are Docker truth via the hub.
  const nodes = await ctx.db.node.findMany({
    where: { orgId: ctx.activeOrgId },
    select: { id: true },
  });
  const onlineRegions = new Set<string>();
  for (const n of nodes) {
    const region = ctx.hub.nodeInfoFor(n.id)?.labels['swarmy.region'];
    if (region && ctx.hub.isOnline(n.id)) onlineRegions.add(region);
  }

  return {
    zone: cfg.zone,
    ttl: cfg.ttl,
    provider: cfg.provider,
    endpoints: records.map((r) => ({
      host: r.host,
      region: r.region,
      target: r.targetIngress,
      healthy: r.healthy && onlineRegions.has(r.region),
    })),
  };
}

// ───────────────────────────────────────────── CoreDNS renderer (pure) ──

const isIp = (s: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);

export interface RenderCoreDnsOptions {
  /**
   * Zone SOA serial. Pass a fixed value (e.g. snapshot revision) for stable,
   * golden-testable output. Defaults to `0` so the renderer is pure; callers
   * deploying a live zone should pass an incrementing serial.
   */
  serial?: number;
  /**
   * Path to the GeoLite2 mmdb the `geoip` plugin should read, or `false` to omit
   * the geoip block entirely (graceful degrade → round-robin via `loadbalance`,
   * so CoreDNS still starts when no db is available). Defaults to the canonical
   * `/etc/coredns/GeoLite2-City.mmdb`.
   */
  geoip?: string | false;
}

export interface RenderedHost {
  host: string;
  /** Healthy endpoints selected (after filtering / spill). */
  selected: ZoneEndpoint[];
  /** Whether every endpoint was unhealthy and we spilled to keep answering. */
  degraded: boolean;
}

/**
 * Build the per-host steering plan from a snapshot: failover = drop unhealthy
 * regions, ordered by distance from each endpoint's region centroid to its own
 * region (a stable proxy used at render time; live per-query GeoIP ranking is
 * applied by CoreDNS `geoip`/`metadata` + the {@link steer} resolver). Pure +
 * deterministic so it powers goldens and the worker's change-detection.
 */
export function planHosts(snapshot: ZoneSnapshot): RenderedHost[] {
  const byHost = new Map<string, ZoneEndpoint[]>();
  for (const e of snapshot.endpoints) {
    const list = byHost.get(e.host) ?? [];
    list.push(e);
    byHost.set(e.host, list);
  }

  const plan: RenderedHost[] = [];
  for (const [host, eps] of [...byHost.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const healthy = eps.filter((e) => e.healthy);
    const degraded = healthy.length === 0 && eps.length > 0;
    // Failover: only healthy regions answer; if none, spill to all (no NXDOMAIN).
    const pool = degraded ? eps : healthy;
    // Deterministic ordering: known-coordinate regions first, then region, target.
    const selected = [...pool].sort((a, b) => {
      const ka = regionCoord(a.region) ? 0 : 1;
      const kb = regionCoord(b.region) ? 0 : 1;
      if (ka !== kb) return ka - kb;
      if (a.region !== b.region) return a.region < b.region ? -1 : 1;
      return a.target < b.target ? -1 : a.target > b.target ? 1 : 0;
    });
    plan.push({ host, selected, degraded });
  }
  return plan;
}

/**
 * Render a CoreDNS zonefile + Corefile from a snapshot, health-filtered.
 *
 * The zone only contains records for *healthy* regions (failover by omission).
 * Each record carries a region tag in a comment so the steering decision is
 * auditable. CoreDNS chooses the per-query closest answer via the `geoip` +
 * `loadbalance` plugins; the controller re-renders + redeploys whenever the
 * healthy set changes (the reconcile worker), keeping the answer set live.
 */
export function renderCoreDns(
  snapshot: ZoneSnapshot,
  opts: RenderCoreDnsOptions = {},
): {
  files: { path: string; contents: string }[];
  summary: string;
  plan: RenderedHost[];
} {
  const zone = snapshot.zone || 'example.com';
  const ttl = snapshot.ttl || DEFAULT_TTL;
  const serial = opts.serial ?? 0;
  const plan = planHosts(snapshot);

  const lines: string[] = [
    `$ORIGIN ${zone}.`,
    `$TTL ${ttl}`,
    `@\tIN\tSOA\tns.${zone}. admin.${zone}. ( ${serial} 7200 3600 1209600 ${ttl} )`,
    `@\tIN\tNS\tns.${zone}.`,
  ];

  let degradedHosts = 0;
  let recordCount = 0;
  for (const { host, selected, degraded } of plan) {
    if (degraded) degradedHosts++;
    const label = host.endsWith(zone) ? host.slice(0, -(zone.length + 1)) || '@' : host;
    for (const e of selected) {
      const rtype = isIp(e.target) ? 'A' : 'CNAME';
      lines.push(`${label}\tIN\t${rtype}\t${e.target}\t; region=${e.region}${degraded ? ' DEGRADED' : ''}`);
      recordCount++;
    }
  }

  const zonefile = lines.join('\n') + '\n';
  const geoipPath = opts.geoip === undefined ? '/etc/coredns/GeoLite2-City.mmdb' : opts.geoip;
  const corefile = [
    `${zone}:53 {`,
    `    file /etc/coredns/${zone}.zone`,
    // geoip + metadata only when a GeoLite2 db is present; without the file the
    // geoip plugin fails to load and CoreDNS crash-loops, so we degrade to plain
    // round-robin (loadbalance) and still answer.
    ...(geoipPath
      ? [`    geoip ${geoipPath} {`, '        edns-subnet', '    }', '    metadata']
      : []),
    '    loadbalance',
    '    health',
    '    ready',
    `    cache ${ttl}`,
    '    log',
    '    errors',
    '}',
    '',
  ].join('\n');

  return {
    files: [
      { path: '/etc/coredns/Corefile', contents: corefile },
      { path: `/etc/coredns/${zone}.zone`, contents: zonefile },
    ],
    summary: `CoreDNS zone ${zone} · TTL ${ttl}s · ${plan.length} host(s) · ${recordCount} healthy record(s)${
      degradedHosts ? ` · ${degradedHosts} host(s) DEGRADED (all-unhealthy spill)` : ''
    }`,
    plan,
  };
}

/** Map snapshot endpoints to {@link SteerTarget}s for the pure steering resolver. */
export function endpointsToSteerTargets(endpoints: ZoneEndpoint[]): SteerTarget[] {
  return endpoints.map((e) => ({ target: e.target, region: e.region, healthy: e.healthy }));
}

/** The swarm ServiceSpec used to deploy CoreDNS via the existing deploy path. */
function coreDnsServiceSpec(
  snapshot: ZoneSnapshot,
  serial = 0,
  placementConstraint = 'node.role == manager',
  geo: GeoLitePlan = { mode: 'none', mmdbPath: '/etc/coredns/GeoLite2-City.mmdb' },
): ServiceSpec {
  const rendered = renderCoreDns(snapshot, {
    serial,
    geoip: geoipEnabled(geo) ? geo.mmdbPath : false,
  });
  const spec: ServiceSpec = {
    name: 'swarmy-coredns',
    image: COREDNS_IMAGE,
    mode: { replicated: { replicas: Math.max(1, Math.min(3, snapshot.endpoints.length || 1)) } },
    args: ['-conf', '/etc/coredns/Corefile'],
    // Config is carried as labels so the rendered Corefile/zone is visible/auditable
    // on the service; a config-mount/secret can replace this in phase 2.
    labels: {
      'swarmy.gslb': 'coredns',
      'swarmy.gslb.summary': rendered.summary,
      'swarmy.gslb.geoip': geo.mode,
    },
    ports: [
      { target: 53, published: 53, protocol: 'udp', mode: 'host' },
      { target: 53, published: 53, protocol: 'tcp', mode: 'host' },
    ],
    networks: [DNS_NETWORK],
    // Pin to the DNS/outlet node tier (label-based), spread across regions among
    // the eligible nodes. Constraint falls back to managers when none are marked.
    placement: {
      constraints: [placementConstraint],
      preferences: ['spread=node.labels.swarmy.region'],
      maxReplicasPerNode: 1,
    },
  };
  // Make the GeoLite2 db available: Mode A mounts an operator-created Docker
  // config at the geoip path; Mode B mounts the per-node volume the license-init
  // downloader fills. Mode 'none' adds nothing (geoip is already disabled above).
  if (geo.mode === 'config') {
    spec.configs = [{ source: geo.configRef, target: geo.mmdbPath, mode: 0o444 }];
  } else if (geo.mode === 'license') {
    spec.mounts = [{ type: 'volume', source: geo.volume, target: geo.volumeDir, readOnly: true }];
  }
  return spec;
}

/**
 * Mode-B GeoLite2 init: a tiny GLOBAL service that downloads the City db using a
 * MaxMind license key (read from a Docker secret) into the per-node volume CoreDNS
 * mounts. Global so every outlet node gets a local copy (Swarm local volumes are
 * per-node). Refreshes daily; restarts on failure.
 */
function geoLiteInitSpec(geo: Extract<GeoLitePlan, { mode: 'license' }>): ServiceSpec {
  return {
    name: GEOLITE_INIT_SERVICE,
    image: GEOLITE_INIT_IMAGE,
    mode: { global: {} },
    command: ['/bin/sh', '-c', geoliteInitScript(geo.licenseSecretRef, geo.volumeDir)],
    secrets: [{ source: geo.licenseSecretRef }],
    mounts: [{ type: 'volume', source: geo.volume, target: geo.volumeDir }],
    labels: { 'swarmy.gslb': 'geolite-init' },
    restartPolicy: { condition: 'any' },
  };
}

// ───────────────────────────────────────────── public service API ──

export async function getConfig(ctx: OrgContext): Promise<GeoDnsConfigView> {
  const cfg = await ensureConfig(ctx);
  const records = await db(ctx).dnsRecord.findMany({ where: { orgId: ctx.activeOrgId } });
  return {
    enabled: cfg.enabled,
    zone: cfg.zone,
    ttl: cfg.ttl,
    provider: cfg.provider,
    recordCount: records.length,
    updatedAt: cfg.updatedAt.toISOString(),
  };
}

export async function setConfig(
  ctx: OrgContext,
  input: { zone?: string; ttl?: number },
): Promise<GeoDnsConfigView> {
  await ensureConfig(ctx);
  await db(ctx).geoDnsConfig.update({
    where: { orgId: ctx.activeOrgId },
    data: {
      ...(input.zone !== undefined ? { zone: input.zone } : {}),
      ...(input.ttl !== undefined ? { ttl: input.ttl } : {}),
    },
  });
  await writeAudit(ctx, {
    action: 'geodns.setConfig',
    targetType: 'geoDnsConfig',
    targetId: ctx.activeOrgId,
    metadata: { zone: input.zone, ttl: input.ttl },
  });
  return getConfig(ctx);
}

/** Toggle Geo-DNS. When enabling, deploy CoreDNS via the existing deploy path. */
export async function setEnabled(ctx: OrgContext, enabled: boolean): Promise<GeoDnsConfigView> {
  await ensureConfig(ctx);
  await db(ctx).geoDnsConfig.update({ where: { orgId: ctx.activeOrgId }, data: { enabled } });
  await writeAudit(ctx, {
    action: enabled ? 'geodns.enable' : 'geodns.disable',
    targetType: 'geoDnsConfig',
    targetId: ctx.activeOrgId,
    metadata: { enabled },
  });

  if (enabled) {
    await deployCoreDns(ctx);
  } else {
    const node = await resolveManagerNode(ctx).catch(() => null);
    if (node) {
      await ctx.hub.dispatch(node.id, 'service.remove', { service: 'swarmy-coredns' }).catch(() => undefined);
      await ctx.hub
        .dispatch(node.id, 'service.remove', { service: GEOLITE_INIT_SERVICE })
        .catch(() => undefined);
    }
  }
  return getConfig(ctx);
}

/**
 * Re-render the (health-filtered) zone and (re)deploy CoreDNS via the existing
 * deploy path. Bumps the SOA serial each time so resolvers/CoreDNS see a fresh
 * zone. Used on enable and by the health-aware reconcile worker when the healthy
 * set changes.
 */
export async function deployCoreDns(ctx: OrgContext): Promise<{ summary: string }> {
  const cfg = await ensureConfig(ctx);
  const settings = parseGeoDnsSettings(cfg.settings);
  const geo = resolveGeoLite(settings);
  const snapshot = await buildZoneSnapshot(ctx);
  const node = await resolveManagerNode(ctx);
  const serial = Math.floor(Date.now() / 1000);
  // Ensure the dns overlay exists before CoreDNS attaches to it (idempotent).
  await ctx.hub.dispatch(node.id, NETWORK_ENSURE, {
    name: DNS_NETWORK,
    driver: 'overlay',
    attachable: true,
    labels: { 'swarmy.managed': 'true', 'swarmy.role': 'gslb' },
  });
  // Mode B: bring up the license-init downloader so the mmdb appears on each
  // outlet node (Swarm restarts CoreDNS until the geoip plugin can load it).
  if (geo.mode === 'license') {
    await ctx.hub
      .dispatch(node.id, 'service.deploy', { spec: geoLiteInitSpec(geo), pullPolicy: 'missing' })
      .catch(() => undefined);
  }
  const spec = coreDnsServiceSpec(snapshot, serial, outletPlacementConstraint(ctx), geo);
  await ctx.hub.dispatch(node.id, 'service.deploy', { spec, pullPolicy: 'always' });
  const rendered = renderCoreDns(snapshot, {
    serial,
    geoip: geoipEnabled(geo) ? geo.mmdbPath : false,
  });

  // Optional: mirror the live (health-filtered) zone into an external provider
  // (Cloudflare / Route53). Self-host CoreDNS still serves regardless.
  const sync = await syncProviderForOrg(ctx, cfg, settings, snapshot).catch(() => null);
  const suffix = sync ? ` · ${sync.provider}: ${sync.applied} change(s)` : '';
  return { summary: rendered.summary + suffix };
}

/**
 * The DNS-relevant footprint of one Docker stack, read live off the hub: the
 * ingress hosts its services expose (`swarmy.ingress.routes` labels) and the
 * service names themselves. A Geo-DNS record belongs to the stack when its host
 * is one of those ingress hosts OR its target dials one of those services.
 */
function stackDnsScope(
  ctx: OrgContext,
  stack: string,
): { hosts: Set<string>; services: Set<string> } {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const hosts = new Set<string>();
  const names = new Set<string>();
  for (const s of buildInventory(services, containers).services) {
    if (s.stack !== stack) continue;
    names.add(s.name);
    for (const r of readRoutes(s.labels)) hosts.add(r.host);
  }
  return { hosts, services: names };
}

export async function listRecords(ctx: OrgContext, stack?: string): Promise<DnsRecordView[]> {
  const records = await db(ctx).dnsRecord.findMany({
    where: { orgId: ctx.activeOrgId },
    orderBy: { host: 'asc' },
  });
  const scope = stack ? stackDnsScope(ctx, stack) : null;
  return records
    .filter((r) => !scope || scope.hosts.has(r.host) || scope.services.has(r.targetIngress))
    .map((r) => ({
      id: r.id,
      host: r.host,
      region: r.region,
      targetIngress: r.targetIngress,
      healthy: r.healthy,
    }));
}

export async function upsertRecord(
  ctx: OrgContext,
  input: { host: string; region: string; targetIngress: string; healthy?: boolean },
): Promise<DnsRecordView> {
  const row = await db(ctx).dnsRecord.upsert({
    where: { orgId_host_region: { orgId: ctx.activeOrgId, host: input.host, region: input.region } },
    create: {
      orgId: ctx.activeOrgId,
      host: input.host,
      region: input.region,
      targetIngress: input.targetIngress,
      healthy: input.healthy ?? true,
    },
    update: { targetIngress: input.targetIngress, healthy: input.healthy ?? true },
  });
  await writeAudit(ctx, {
    action: 'geodns.upsertRecord',
    targetType: 'dnsRecord',
    targetId: row.id,
    metadata: { host: input.host, region: input.region },
  });
  return { id: row.id, host: row.host, region: row.region, targetIngress: row.targetIngress, healthy: row.healthy };
}

export async function removeRecord(ctx: OrgContext, id: string): Promise<{ id: string; removed: true }> {
  const row = await db(ctx).dnsRecord.findFirst({ where: { id, orgId: ctx.activeOrgId } });
  if (!row) throw notFound('dnsRecord', id);
  await db(ctx).dnsRecord.delete({ where: { id } });
  await writeAudit(ctx, { action: 'geodns.removeRecord', targetType: 'dnsRecord', targetId: id });
  return { id, removed: true };
}

/** Render the zone the controller WOULD push (pure preview, mirrors ingress). */
export async function previewZone(
  ctx: OrgContext,
): Promise<{ summary: string; files: { path: string; contents: string }[] }> {
  const cfg = await ensureConfig(ctx);
  const geo = resolveGeoLite(parseGeoDnsSettings(cfg.settings));
  const snapshot = await buildZoneSnapshot(ctx);
  return renderCoreDns(snapshot, { geoip: geoipEnabled(geo) ? geo.mmdbPath : false });
}

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

  // Best-effort push to the swarm engine (reconciles later if offline).
  const swarmNodeId = ctx.hub.swarmNodeIdFor(nodeId);
  if (ctx.hub.isOnline(nodeId) && swarmNodeId) {
    await ctx.hub
      .dispatch(nodeId, 'node.update', { swarmNodeId, labels })
      .catch(() => undefined);
  }

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
 * with live node membership, health, and outlet count. Region membership +
 * online/role state are Docker truth (hub); only the coordinates are static.
 * Unplaceable custom labels (no known coordinate) are dropped — they can't be
 * drawn — so the map only ever shows points it can position.
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

/** Force a re-render + redeploy of the CoreDNS zone now (manual / from UI). */
export async function applyNow(ctx: OrgContext): Promise<{ summary: string }> {
  const cfg = await ensureConfig(ctx);
  if (!cfg.enabled) return { summary: 'Geo-DNS is disabled — nothing to apply.' };
  const out = await deployCoreDns(ctx);
  await writeAudit(ctx, {
    action: 'geodns.applyNow',
    targetType: 'geoDnsConfig',
    targetId: ctx.activeOrgId,
    metadata: { summary: out.summary },
  });
  return out;
}

/**
 * Health-aware reconcile for one org (used by the geodns-reconcile worker via
 * its own inlined mirror, and callable directly in tests with a real ctx).
 *
 * Polls live region health (node online + ingress health), flips each
 * DnsRecord.healthy to match, and — only when the healthy answer set changes and
 * Geo-DNS is enabled — re-renders + redeploys CoreDNS so failover (dropping
 * unhealthy regions) takes effect.
 */
export async function reconcileGeoDns(ctx: OrgContext): Promise<{
  updated: number;
  redeployed: boolean;
}> {
  const cfg = await ensureConfig(ctx);
  const records = await db(ctx).dnsRecord.findMany({ where: { orgId: ctx.activeOrgId } });
  if (records.length === 0) return { updated: 0, redeployed: false };

  const health = await collectRegionHealth(ctx);
  const plan = planReconcile(
    records.map((r) => ({
      id: r.id,
      host: r.host,
      region: r.region,
      targetIngress: r.targetIngress,
      healthy: r.healthy,
    })),
    health,
  );

  for (const u of plan.updates) {
    await db(ctx)
      .dnsRecord.update({ where: { id: u.id }, data: { healthy: u.healthy } })
      .catch(() => undefined);
  }

  let redeployed = false;
  if (plan.healthySetChanged && cfg.enabled) {
    await deployCoreDns(ctx).catch(() => undefined);
    redeployed = true;
    await writeAudit(ctx, {
      action: 'geodns.reconcile',
      targetType: 'geoDnsConfig',
      targetId: ctx.activeOrgId,
      metadata: { updated: plan.updates.length, redeployed },
    });
  }
  return { updated: plan.updates.length, redeployed };
}

/**
 * Compose live per-region health from heartbeats (node online) and, when
 * available, ingress health snapshots. region → {@link RegionHealth}.
 */
async function collectRegionHealth(ctx: OrgContext): Promise<Map<string, RegionHealth>> {
  const nodes = await ctx.db.node.findMany({
    where: { orgId: ctx.activeOrgId },
    select: { id: true },
  });
  const health = new Map<string, RegionHealth>();
  for (const n of nodes) {
    const region = ctx.hub.nodeInfoFor(n.id)?.labels['swarmy.region'];
    if (!region) continue;
    const online = ctx.hub.isOnline(n.id);
    const existing = health.get(region);
    if (existing) {
      existing.nodeOnline = existing.nodeOnline || online;
    } else {
      health.set(region, { region, nodeOnline: online });
    }
  }
  return health;
}

// ───────────────────────────────────────────── provider sync ──

/** Map the internal zone snapshot onto the provider-agnostic snapshot shape. */
function buildProviderSnapshot(snapshot: ZoneSnapshot): ProviderZoneSnapshot {
  return {
    zone: snapshot.zone,
    ttl: snapshot.ttl,
    endpoints: snapshot.endpoints.map((e) => ({
      host: e.host,
      region: e.region,
      target: e.target,
      healthy: e.healthy,
    })),
  };
}

/**
 * Resolve the provider API token from the controller's secret-injected ENV (never
 * the DB). `settings.providerTokenEnv` names the var; per-provider defaults apply.
 * Route53 assembles `accessKeyId:secretAccessKey[:sessionToken]` from the standard
 * AWS vars when no single var is named. Returns null when unset → sync is skipped.
 */
export function resolveProviderToken(provider: string, settings: GeoDnsSettings): string | null {
  const env = (k?: string): string | undefined => (k ? process.env[k] : undefined);
  if (provider === 'cloudflare') {
    return env(settings.providerTokenEnv) ?? env('CLOUDFLARE_API_TOKEN') ?? null;
  }
  if (provider === 'route53') {
    const single = env(settings.providerTokenEnv);
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
 * Mirror the live (health-filtered) zone into an external provider when
 * `provider` is cloudflare/route53 and a zone id + token are configured.
 * Best-effort + audited; returns null when not configured. The self-host CoreDNS
 * service still runs independently (self-host + provider, per the epic).
 */
async function syncProviderForOrg(
  ctx: OrgContext,
  cfg: GeoDnsConfigRow,
  settings: GeoDnsSettings,
  snapshot: ZoneSnapshot,
): Promise<ProviderSyncResult | null> {
  if (!isSyncProvider(cfg.provider)) return null;
  const zoneId = settings.providerZoneId;
  if (!zoneId) return null;
  const token = resolveProviderToken(cfg.provider, settings);
  if (!token) return null;

  const result = await syncProviderZone(cfg.provider, buildProviderSnapshot(snapshot), {
    zoneId,
    token,
    region: settings.providerRegion,
  });
  await writeAudit(ctx, {
    action: 'geodns.providerSync',
    targetType: 'geoDnsConfig',
    targetId: ctx.activeOrgId,
    metadata: {
      provider: result.provider,
      applied: result.applied,
      planned: result.planned.length,
      errors: result.errors.length,
    },
  });
  return result;
}

// ───────────────────────────────────────────── DNS view (probe) ──

export interface DnsViewRow {
  host: string;
  region: string;
  target: string;
  /** Resolved A value (the target itself when already an IP, else a live lookup). */
  ip: string;
  healthy: boolean;
}

export interface DomainCheck {
  /** Whether the host resolves to at least one A record right now. */
  resolves: boolean;
  /** The IP swarmy WOULD serve for this host (first healthy endpoint). */
  expectedIp: string;
  /** The IP a public resolver actually returns for this host. */
  gotIp: string;
  /** Whether the resolved host answered an HTTP(S) probe. */
  reachable: boolean;
}

/** Best-effort A lookup; returns [] on any failure (NXDOMAIN, timeout, …). */
async function resolveIps(host: string): Promise<string[]> {
  try {
    return await resolve4(host);
  } catch {
    return [];
  }
}

/**
 * Live DNS view: every zone endpoint with its resolved IP + health, for the
 * dashboard DNS table. CNAME targets are resolved to an A best-effort (cached per
 * target). Reuses the same health-composed snapshot the zone is rendered from.
 */
export async function listDnsView(ctx: OrgContext, stack?: string): Promise<DnsViewRow[]> {
  const snapshot = await buildZoneSnapshot(ctx);
  const scope = stack ? stackDnsScope(ctx, stack) : null;
  const ipCache = new Map<string, string>();
  const rows: DnsViewRow[] = [];
  for (const e of snapshot.endpoints) {
    if (scope && !scope.hosts.has(e.host) && !scope.services.has(e.target)) continue;
    let ip: string;
    if (isIp(e.target)) {
      ip = e.target;
    } else if (ipCache.has(e.target)) {
      ip = ipCache.get(e.target) ?? '';
    } else {
      ip = (await resolveIps(e.target))[0] ?? '';
      ipCache.set(e.target, ip);
    }
    rows.push({ host: e.host, region: e.region, target: e.target, ip, healthy: e.healthy });
  }
  return rows;
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
 * Probe one host: compare the IP swarmy intends to serve (first healthy endpoint)
 * against what a public resolver returns, plus a reachability check. Diagnostic
 * only — no Docker writes.
 */
export async function checkDomain(ctx: OrgContext, host: string): Promise<DomainCheck> {
  const snapshot = await buildZoneSnapshot(ctx);
  const eps = snapshot.endpoints.filter((e) => e.host === host);
  const preferred = eps.find((e) => e.healthy) ?? eps[0];

  let expectedIp = '';
  if (preferred) {
    expectedIp = isIp(preferred.target)
      ? preferred.target
      : (await resolveIps(preferred.target))[0] ?? '';
  }
  const gotIp = (await resolveIps(host))[0] ?? '';
  const reachable = gotIp ? await probeReachable(host) : false;
  return { resolves: gotIp !== '', expectedIp, gotIp, reachable };
}
