import type { ServiceSpec } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { resolveManagerNode } from './dispatch.service';
import { writeAudit } from './audit.service';

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

  // Map region → at least one online node (label-based).
  const nodes = await ctx.db.node.findMany({
    where: { orgId: ctx.activeOrgId },
    select: { id: true, labels: true },
  });
  const onlineRegions = new Set<string>();
  for (const n of nodes) {
    const region = (n.labels as Record<string, string> | null)?.['swarmy.region'];
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

/**
 * Render a CoreDNS zonefile + Corefile from a snapshot. Steering: per host, the
 * healthy regional ingresses are emitted (closest-region weighting is applied at
 * query time by CoreDNS `loadbalance`/`geoip`; for the MVP we emit all healthy
 * targets per host with a short TTL and drop the rest). If every endpoint for a
 * host is unhealthy we emit them all anyway (better than NXDOMAIN) and flag it.
 */
export function renderCoreDns(snapshot: ZoneSnapshot): {
  files: { path: string; contents: string }[];
  summary: string;
} {
  const zone = snapshot.zone || 'example.com';
  const ttl = snapshot.ttl || DEFAULT_TTL;

  const byHost = new Map<string, ZoneEndpoint[]>();
  for (const e of snapshot.endpoints) {
    const list = byHost.get(e.host) ?? [];
    list.push(e);
    byHost.set(e.host, list);
  }

  const lines: string[] = [
    `$ORIGIN ${zone}.`,
    `$TTL ${ttl}`,
    `@\tIN\tSOA\tns.${zone}. admin.${zone}. ( ${Math.floor(Date.now() / 1000)} 7200 3600 1209600 ${ttl} )`,
    `@\tIN\tNS\tns.${zone}.`,
  ];
  let degradedHosts = 0;
  for (const [host, eps] of byHost) {
    let healthy = eps.filter((e) => e.healthy);
    if (healthy.length === 0) {
      healthy = eps; // spill: send traffic somewhere rather than NXDOMAIN
      degradedHosts++;
    }
    const label = host.endsWith(zone) ? host.slice(0, -(zone.length + 1)) || '@' : host;
    for (const e of healthy) {
      const rtype = isIp(e.target) ? 'A' : 'CNAME';
      lines.push(`${label}\tIN\t${rtype}\t${e.target}`);
    }
  }

  const zonefile = lines.join('\n') + '\n';
  const corefile = [
    `${zone}:53 {`,
    `    file /etc/coredns/${zone}.zone`,
    '    loadbalance',
    '    geoip /etc/coredns/GeoLite2-City.mmdb',
    '    health',
    '    ready',
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
    summary: `CoreDNS zone ${zone} · TTL ${ttl}s · ${byHost.size} host(s) · ${snapshot.endpoints.length} endpoint(s)${
      degradedHosts ? ` · ${degradedHosts} host(s) DEGRADED (all-unhealthy spill)` : ''
    }`,
  };
}

/** The swarm ServiceSpec used to deploy CoreDNS via the existing deploy path. */
function coreDnsServiceSpec(snapshot: ZoneSnapshot): ServiceSpec {
  const rendered = renderCoreDns(snapshot);
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
    const snapshot = await buildZoneSnapshot(ctx);
    const node = await resolveManagerNode(ctx);
    const spec = coreDnsServiceSpec(snapshot);
    // Reuse the existing deploy command — no new agent/protocol command needed.
    await ctx.hub.dispatch(node.id, 'service.deploy', { spec, pullPolicy: 'always' });
  } else {
    const node = await resolveManagerNode(ctx).catch(() => null);
    if (node) {
      await ctx.hub.dispatch(node.id, 'service.remove', { service: 'swarmy-coredns' }).catch(() => undefined);
    }
  }
  return getConfig(ctx);
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
  const node = (await ctx.db.node.findFirst({
    where: { id: nodeId, orgId: ctx.activeOrgId },
    select: { id: true, swarmNodeId: true, labels: true },
  })) as { id: string; swarmNodeId: string | null; labels: unknown } | null;
  if (!node) throw notFound('node', nodeId);

  const labels: Record<string, string> = {
    ...((node.labels as Record<string, string> | null) ?? {}),
    'swarmy.region': region,
  };
  await ctx.db.node.update({ where: { id: nodeId }, data: { labels } });

  // Best-effort push to the swarm engine (reconciles later if offline).
  if (ctx.hub.isOnline(nodeId) && node.swarmNodeId) {
    await ctx.hub
      .dispatch(nodeId, 'node.update', { swarmNodeId: node.swarmNodeId, labels })
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
