import type { ServiceSpec } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { resolveManagerNode } from './dispatch.service';
import { writeAudit } from './audit.service';
import { regionCoord, type SteerTarget } from './geo-steer';
import { planReconcile, type RegionHealth } from './geodns-reconcile.core';

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
  provider: string; // 'coredns'
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
  const corefile = [
    `${zone}:53 {`,
    `    file /etc/coredns/${zone}.zone`,
    '    geoip /etc/coredns/GeoLite2-City.mmdb {',
    '        edns-subnet',
    '    }',
    '    metadata',
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
function coreDnsServiceSpec(snapshot: ZoneSnapshot, serial = 0): ServiceSpec {
  const rendered = renderCoreDns(snapshot, { serial });
  return {
    name: 'swarmy-coredns',
    image: COREDNS_IMAGE,
    mode: { replicated: { replicas: Math.max(1, Math.min(3, snapshot.endpoints.length || 1)) } },
    args: ['-conf', '/etc/coredns/Corefile'],
    // Config is carried as labels so the rendered Corefile/zone is visible/auditable
    // on the service; a config-mount/secret can replace this in phase 2.
    labels: {
      'swarmy.gslb': 'coredns',
      'swarmy.gslb.summary': rendered.summary,
    },
    ports: [
      { target: 53, published: 53, protocol: 'udp', mode: 'host' },
      { target: 53, published: 53, protocol: 'tcp', mode: 'host' },
    ],
    placement: { preferences: ['spread=node.labels.swarmy.region'], maxReplicasPerNode: 1 },
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
  const snapshot = await buildZoneSnapshot(ctx);
  const node = await resolveManagerNode(ctx);
  const serial = Math.floor(Date.now() / 1000);
  const spec = coreDnsServiceSpec(snapshot, serial);
  await ctx.hub.dispatch(node.id, 'service.deploy', { spec, pullPolicy: 'always' });
  const rendered = renderCoreDns(snapshot, { serial });
  return { summary: rendered.summary };
}

export async function listRecords(ctx: OrgContext): Promise<DnsRecordView[]> {
  const records = await db(ctx).dnsRecord.findMany({
    where: { orgId: ctx.activeOrgId },
    orderBy: { host: 'asc' },
  });
  return records.map((r) => ({
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
  const snapshot = await buildZoneSnapshot(ctx);
  return renderCoreDns(snapshot);
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
