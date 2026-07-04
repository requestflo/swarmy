import {
  composeZoneSnapshot,
  zoneSignature,
  type ComposeConflict,
} from '@swarmy/dns';
import type {
  DnsSnapshotBundle,
  DnsZoneSnapshot,
  GeoEndpoint,
  GeoRecord,
  StaticDnsRecord,
} from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { listRoutesForOrg } from './ingress-routes';
import { publicIpFromLabels } from './node.service';

/**
 * Snapshot composition — gathers the DERIVED inputs (invariant #5,
 * geo-edge-routing skill) and hands them to the pure `composeZoneSnapshot`:
 *
 * - hostnames: ingress service routes + status pages + webhooks + AI outlets
 * - endpoints: ingress+outlet nodes with a region and a public IP, health from
 *   the hub (node online; M8 folds in Caddy liveness)
 * - manual records: the repurposed DnsRecord rows
 *
 * SOA serials bump ONLY when a zone's composed content signature changes
 * (persisted on DnsZone), so pushes are idempotent and delegation checks
 * comparing serials mean something.
 */

export interface IngressHost {
  host: string;
  source: NonNullable<GeoRecord['source']>;
  /** Docker stack the host belongs to (UI provenance), when known. */
  stack?: string;
}

interface DnsZoneRow {
  id: string;
  orgId: string;
  zone: string;
  mode: string;
  enabled: boolean;
  ttl: number;
  serial: number;
  apexToEdge: boolean;
  autoWww: boolean;
  advertisedNodeIds: unknown;
  settings: unknown;
}

interface DnsRecordRow {
  id: string;
  zoneId: string;
  name: string;
  type: string;
  value: string;
  ttl: number | null;
  priority: number | null;
}

/** Narrow typed accessor for the new delegates (schema is source of truth). */
export function dnsDb(ctx: OrgContext): {
  dnsZone: {
    findMany(args: object): Promise<DnsZoneRow[]>;
    findFirst(args: object): Promise<DnsZoneRow | null>;
    create(args: object): Promise<DnsZoneRow>;
    update(args: object): Promise<DnsZoneRow>;
    delete(args: object): Promise<DnsZoneRow>;
  };
  dnsRecord: {
    findMany(args: object): Promise<DnsRecordRow[]>;
    findFirst(args: object): Promise<DnsRecordRow | null>;
    upsert(args: object): Promise<DnsRecordRow>;
    delete(args: object): Promise<DnsRecordRow>;
  };
} {
  return ctx.db as never;
}

/**
 * Every hostname ingress will answer for — the single source both the ingress
 * render and the DNS zone composition read, so a domain attached anywhere
 * "just works" in DNS.
 */
export async function listAllIngressHosts(ctx: OrgContext): Promise<IngressHost[]> {
  const hosts = new Map<string, IngressHost>();
  const add = (host: string | null | undefined, source: IngressHost['source'], stack?: string) => {
    if (!host) return;
    const key = host.toLowerCase().replace(/\.+$/, '');
    if (!hosts.has(key)) hosts.set(key, { host: key, source, stack });
  };

  for (const r of listRoutesForOrg(ctx)) add(r.route.host, 'route', r.stack);

  const [pages, endpoints] = await Promise.all([
    ctx.db.statusPage.findMany({
      where: { orgId: ctx.activeOrgId, enabled: true, domain: { not: null } },
      select: { domain: true },
    }),
    ctx.db.inboundEndpoint.findMany({
      where: { orgId: ctx.activeOrgId, domain: { not: null } },
      select: { domain: true },
    }),
  ]);
  for (const p of pages) add(p.domain, 'status-page');
  for (const e of endpoints) add(e.domain, 'webhook');

  // AI outlets carry their domain on stack config; lazy import avoids a cycle.
  const { listOutlets } = await import('./ai.service');
  for (const o of await listOutlets(ctx)) add(o.domain, 'ai-outlet');

  return [...hosts.values()];
}

/** Edge telemetry is stale after this long — fall back to heartbeat-only health. */
const INGRESS_STATUS_TTL_MS = 2 * 60_000;

/**
 * The steerable answer set: nodes marked ingress AND outlet, with a region and
 * a public IP. Health = agent online AND (when the node has reported edge
 * telemetry recently) its local Caddy task is running — a node whose Caddy
 * died must leave the answers even while the agent websocket is healthy.
 * Nodes that never reported (old agents, boot race) degrade gracefully to
 * heartbeat-only health.
 */
export function collectGeoEndpoints(ctx: OrgContext): GeoEndpoint[] {
  const ingress = new Set(ctx.hub.nodesByRole(ctx.activeOrgId, 'ingress'));
  const outlet = new Set(ctx.hub.nodesByRole(ctx.activeOrgId, 'outlet'));
  const endpoints: GeoEndpoint[] = [];
  for (const nodeId of ingress) {
    if (!outlet.has(nodeId)) continue;
    const labels = ctx.hub.nodeInfoFor(nodeId)?.labels;
    const region = labels?.['swarmy.region'];
    const ip = publicIpFromLabels(labels);
    if (!region || !ip) continue;
    const online = ctx.hub.isOnline(nodeId);
    const edge = ctx.hub.ingressStatusFor(nodeId);
    const edgeFresh = edge !== undefined && Date.now() - edge.sampledAt < INGRESS_STATUS_TTL_MS;
    endpoints.push({
      nodeId,
      region,
      ip,
      healthy: online && (!edgeFresh || edge.caddyRunning),
    });
  }
  return endpoints.sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1));
}

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

export interface ComposedZone {
  row: DnsZoneRow;
  snapshot: DnsZoneSnapshot;
  conflicts: ComposeConflict[];
}

/** Compose one zone from live inputs (serial = the row's current serial). */
export async function composeZone(
  ctx: OrgContext,
  row: DnsZoneRow,
  inputs?: { hosts: IngressHost[]; endpoints: GeoEndpoint[] },
): Promise<ComposedZone> {
  const hosts = inputs?.hosts ?? (await listAllIngressHosts(ctx));
  const endpoints = inputs?.endpoints ?? collectGeoEndpoints(ctx);
  const endpointByNode = new Map(endpoints.map((e) => [e.nodeId, e]));

  const advertised = asStringArray(row.advertisedNodeIds)
    .map((nodeId) => {
      const labels = ctx.hub.nodeInfoFor(nodeId)?.labels;
      const ip = endpointByNode.get(nodeId)?.ip ?? publicIpFromLabels(labels);
      return ip ? { nodeId, ip } : null;
    })
    .filter((n): n is { nodeId: string; ip: string } => n !== null);

  const inZone = hosts.filter(
    (h) => h.host === row.zone || h.host.endsWith(`.${row.zone}`),
  );

  const manualRecords = (
    await dnsDb(ctx).dnsRecord.findMany({ where: { zoneId: row.id } })
  ).map(
    (r): StaticDnsRecord => ({
      name: r.name,
      type: r.type as StaticDnsRecord['type'],
      value: r.value,
      ttl: r.ttl ?? undefined,
      priority: r.priority ?? undefined,
    }),
  );

  const { snapshot, conflicts } = composeZoneSnapshot({
    zone: {
      name: row.zone,
      ttl: row.ttl,
      serial: row.serial,
      apexToEdge: row.apexToEdge,
      autoWww: row.autoWww,
    },
    advertised,
    autoHosts: inZone.map((h) => ({ host: h.host, source: h.source })),
    endpoints,
    manualRecords,
  });
  return { row, snapshot, conflicts };
}

/** Stored content signature (zone.settings.contentSig) for serial management. */
const sigOf = (settings: unknown): string | undefined =>
  settings && typeof settings === 'object'
    ? ((settings as Record<string, unknown>).contentSig as string | undefined)
    : undefined;

/**
 * Build the org's full push bundle. For each enabled swarmy-ns zone: compose,
 * compare the content signature with the persisted one, and bump the SOA
 * serial (persisting the new signature) when content changed. Bundle version =
 * epoch ms — monotonic across controller restarts.
 */
export async function buildDnsSnapshotBundle(ctx: OrgContext): Promise<{
  bundle: DnsSnapshotBundle;
  conflicts: Record<string, ComposeConflict[]>;
}> {
  const rows = await dnsDb(ctx).dnsZone.findMany({
    where: { orgId: ctx.activeOrgId, enabled: true, mode: 'swarmy-ns' },
    orderBy: { zone: 'asc' },
  });
  const hosts = await listAllIngressHosts(ctx);
  const endpoints = collectGeoEndpoints(ctx);

  const zones: DnsZoneSnapshot[] = [];
  const conflicts: Record<string, ComposeConflict[]> = {};
  for (const row of rows) {
    const composed = await composeZone(ctx, row, { hosts, endpoints });
    let snapshot = composed.snapshot;
    const signature = zoneSignature(snapshot);
    if (sigOf(row.settings) !== signature) {
      const serial = row.serial + 1;
      const settings = {
        ...(typeof row.settings === 'object' && row.settings !== null ? row.settings : {}),
        contentSig: signature,
      };
      await dnsDb(ctx).dnsZone.update({
        where: { id: row.id },
        data: { serial, settings },
      });
      snapshot = { ...snapshot, serial };
    }
    zones.push(snapshot);
    if (composed.conflicts.length > 0) conflicts[row.zone] = composed.conflicts;
  }

  return {
    bundle: { version: Date.now(), generatedAt: new Date().toISOString(), zones },
    conflicts,
  };
}
