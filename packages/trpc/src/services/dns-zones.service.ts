import { resolveNs } from 'node:dns/promises';
import {
  answerQuery,
  decodeSoaSerial,
  encodeSoaQuery,
  regionCoord,
  type ClientLocation,
  type ComposeConflict,
} from '@swarmy/dns';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { writeAudit } from './audit.service';
import {
  composeZone,
  collectGeoEndpoints,
  dnsDb,
} from './dns-snapshot.service';
import { publicIpFromLabels } from './node.service';

/**
 * Zone lifecycle — the registrar-facing artifact. A zone in `swarmy-ns` mode
 * makes swarmy THE authoritative nameserver: the operator pins 2–4
 * ingress+outlet nodes as the advertised set (→ ns1..nsN + glue), points the
 * registrar at them, and everything else derives. `cloudflare`/`route53`
 * modes keep the provider-sync path for users who won't move nameservers.
 */

const ZONE_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const MODES = new Set(['swarmy-ns', 'cloudflare', 'route53']);

export interface DnsZoneView {
  id: string;
  zone: string;
  mode: string;
  enabled: boolean;
  ttl: number;
  serial: number;
  apexToEdge: boolean;
  autoWww: boolean;
  advertisedNodeIds: string[];
  /** Registrar handout: ns hostname + glue IP per pinned node. */
  nameservers: Array<{ label: string; fqdn: string; ip: string; nodeId: string; online: boolean }>;
  /** Provider-sync references (cloudflare/route53 modes). */
  provider: { zoneId?: string; tokenEnv?: string; region?: string };
  conflicts?: ComposeConflict[];
}

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

const providerOf = (settings: unknown): DnsZoneView['provider'] => {
  const o = settings && typeof settings === 'object' ? (settings as Record<string, unknown>) : {};
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;
  return {
    zoneId: str(o.providerZoneId),
    tokenEnv: str(o.providerTokenEnv),
    region: str(o.providerRegion),
  };
};

function toView(
  ctx: OrgContext,
  row: {
    id: string;
    zone: string;
    mode: string;
    enabled: boolean;
    ttl: number;
    serial: number;
    apexToEdge: boolean;
    autoWww: boolean;
    advertisedNodeIds: unknown;
    settings: unknown;
  },
  conflicts?: ComposeConflict[],
): DnsZoneView {
  const advertised = asStringArray(row.advertisedNodeIds);
  return {
    id: row.id,
    zone: row.zone,
    mode: row.mode,
    enabled: row.enabled,
    ttl: row.ttl,
    serial: row.serial,
    apexToEdge: row.apexToEdge,
    autoWww: row.autoWww,
    advertisedNodeIds: advertised,
    nameservers: advertised.map((nodeId, i) => ({
      label: `ns${i + 1}`,
      fqdn: `ns${i + 1}.${row.zone}`,
      ip: publicIpFromLabels(ctx.hub.nodeInfoFor(nodeId)?.labels) ?? '',
      nodeId,
      online: ctx.hub.isOnline(nodeId),
    })),
    provider: providerOf(row.settings),
    conflicts,
  };
}

export async function listZones(ctx: OrgContext): Promise<DnsZoneView[]> {
  const rows = await dnsDb(ctx).dnsZone.findMany({
    where: { orgId: ctx.activeOrgId },
    orderBy: { zone: 'asc' },
  });
  const views: DnsZoneView[] = [];
  for (const row of rows) {
    // Conflicts are compose-time knowledge; cheap enough per zone for the UI.
    const { conflicts } = await composeZone(ctx, row);
    views.push(toView(ctx, row, conflicts));
  }
  return views;
}

export async function createZone(
  ctx: OrgContext,
  input: { zone: string; mode?: string },
): Promise<DnsZoneView> {
  const zone = input.zone.toLowerCase().replace(/\.+$/, '');
  if (!ZONE_RE.test(zone)) throw new Error(`invalid zone name: ${input.zone}`);
  const mode = input.mode && MODES.has(input.mode) ? input.mode : 'swarmy-ns';
  const row = await dnsDb(ctx).dnsZone.create({
    data: { orgId: ctx.activeOrgId, zone, mode },
  });
  await writeAudit(ctx, {
    action: 'dns.zone.create',
    targetType: 'dnsZone',
    targetId: row.id,
    metadata: { zone, mode },
  });
  return toView(ctx, row);
}

export async function updateZone(
  ctx: OrgContext,
  id: string,
  patch: {
    enabled?: boolean;
    mode?: string;
    ttl?: number;
    apexToEdge?: boolean;
    autoWww?: boolean;
    provider?: { zoneId?: string; tokenEnv?: string; region?: string };
  },
): Promise<DnsZoneView> {
  const row = await dnsDb(ctx).dnsZone.findFirst({
    where: { id, orgId: ctx.activeOrgId },
  });
  if (!row) throw notFound('dnsZone', id);
  if (patch.mode && !MODES.has(patch.mode)) throw new Error(`invalid mode: ${patch.mode}`);
  if (patch.ttl !== undefined && (patch.ttl < 10 || patch.ttl > 120)) {
    throw new Error('ttl must be between 10 and 120 seconds');
  }

  const settings =
    patch.provider === undefined
      ? undefined
      : {
          ...(typeof row.settings === 'object' && row.settings !== null ? row.settings : {}),
          providerZoneId: patch.provider.zoneId,
          providerTokenEnv: patch.provider.tokenEnv,
          providerRegion: patch.provider.region,
        };

  const updated = await dnsDb(ctx).dnsZone.update({
    where: { id },
    data: {
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
      ...(patch.ttl !== undefined ? { ttl: patch.ttl } : {}),
      ...(patch.apexToEdge !== undefined ? { apexToEdge: patch.apexToEdge } : {}),
      ...(patch.autoWww !== undefined ? { autoWww: patch.autoWww } : {}),
      ...(settings !== undefined ? { settings } : {}),
    },
  });
  await writeAudit(ctx, {
    action: 'dns.zone.update',
    targetType: 'dnsZone',
    targetId: id,
    metadata: patch as Record<string, unknown>,
  });
  return toView(ctx, updated);
}

export async function removeZone(ctx: OrgContext, id: string): Promise<{ id: string }> {
  const row = await dnsDb(ctx).dnsZone.findFirst({ where: { id, orgId: ctx.activeOrgId } });
  if (!row) throw notFound('dnsZone', id);
  await dnsDb(ctx).dnsZone.delete({ where: { id } });
  await writeAudit(ctx, {
    action: 'dns.zone.remove',
    targetType: 'dnsZone',
    targetId: id,
    metadata: { zone: row.zone },
  });
  return { id };
}

/**
 * Pin the advertised nameserver set (2–4 nodes, order = ns1..nsN). Every node
 * must be ingress+outlet with a known public IP — these become registrar glue
 * records, the ONE thing swarmy cannot change for the user later.
 */
export async function setAdvertisedNs(
  ctx: OrgContext,
  id: string,
  nodeIds: string[],
): Promise<DnsZoneView> {
  const row = await dnsDb(ctx).dnsZone.findFirst({ where: { id, orgId: ctx.activeOrgId } });
  if (!row) throw notFound('dnsZone', id);
  if (nodeIds.length < 2 || nodeIds.length > 4) {
    throw new Error('pin between 2 and 4 nameserver nodes (registrars require ≥2)');
  }
  if (new Set(nodeIds).size !== nodeIds.length) throw new Error('duplicate node in NS set');

  const eligible = new Map(collectGeoEndpoints(ctx).map((e) => [e.nodeId, e]));
  for (const nodeId of nodeIds) {
    if (!eligible.has(nodeId)) {
      throw new Error(
        `node ${nodeId} is not eligible as a nameserver — it needs ingress+outlet roles, a region, and a public IP`,
      );
    }
  }

  const updated = await dnsDb(ctx).dnsZone.update({
    where: { id },
    data: { advertisedNodeIds: nodeIds },
  });
  await writeAudit(ctx, {
    action: 'dns.zone.setAdvertisedNs',
    targetType: 'dnsZone',
    targetId: id,
    metadata: { nodeIds },
  });
  return toView(ctx, updated);
}

// ───────────────────────────────────────────── delegation check ──

export interface DelegationCheck {
  zone: string;
  /** NS names the public DNS currently returns for the zone. */
  publicNs: string[];
  /** Whether the public NS set matches the advertised set. */
  delegated: boolean;
  /** Per advertised nameserver: is it answering authoritatively right now? */
  nameservers: Array<{
    fqdn: string;
    ip: string;
    reachable: boolean;
    serial: number | null;
    serialMatches: boolean;
  }>;
}

/** Direct SOA query against one glue IP (bypasses recursion entirely). */
async function querySoaSerial(ip: string, zone: string): Promise<number | null> {
  const query = encodeSoaQuery(zone, Math.floor(Math.random() * 0xffff));
  try {
    return await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 2500);
      void Bun.udpSocket({
        socket: {
          data(sock: { close(): void }, buf: Uint8Array) {
            clearTimeout(timer);
            sock.close();
            resolve(decodeSoaSerial(buf));
          },
        },
      }).then((sock) => sock.send(query, 53, ip));
    });
  } catch {
    return null;
  }
}

export async function checkDelegation(ctx: OrgContext, id: string): Promise<DelegationCheck> {
  const row = await dnsDb(ctx).dnsZone.findFirst({ where: { id, orgId: ctx.activeOrgId } });
  if (!row) throw notFound('dnsZone', id);
  const view = toView(ctx, row);

  const publicNs = await resolveNs(row.zone)
    .then((ns) => ns.map((n) => n.toLowerCase().replace(/\.$/, '')))
    .catch(() => [] as string[]);
  const advertisedFqdns = new Set(view.nameservers.map((n) => n.fqdn));
  const delegated =
    publicNs.length > 0 && publicNs.every((ns) => advertisedFqdns.has(ns));

  const nameservers = await Promise.all(
    view.nameservers.map(async (ns) => {
      const serial = ns.ip ? await querySoaSerial(ns.ip, row.zone) : null;
      return {
        fqdn: ns.fqdn,
        ip: ns.ip,
        reachable: serial !== null,
        serial,
        serialMatches: serial === row.serial,
      };
    }),
  );

  return { zone: row.zone, publicNs, delegated, nameservers };
}

// ───────────────────────────────────────────── resolution preview ──

export interface ResolutionPreview {
  host: string;
  from: { region?: string; ip?: string };
  answers: Array<{ type: string; value: string; ttl: number }>;
  rcode: string;
  steered: boolean;
  degraded: boolean;
}

/**
 * "What would a client in <region> get?" — runs the REAL `answerQuery` against
 * the zone's current composed snapshot, no sockets involved. Powers the UI's
 * resolve-from widget with exact production behaviour.
 */
export async function previewResolution(
  ctx: OrgContext,
  id: string,
  input: { host: string; region?: string },
): Promise<ResolutionPreview> {
  const row = await dnsDb(ctx).dnsZone.findFirst({ where: { id, orgId: ctx.activeOrgId } });
  if (!row) throw notFound('dnsZone', id);
  const { snapshot } = await composeZone(ctx, row);

  const client: ClientLocation = input.region
    ? { coord: regionCoord(input.region), region: input.region }
    : {};
  const result = answerQuery([snapshot], { name: input.host, type: 'A' } as never, client);

  return {
    host: input.host,
    from: { region: input.region },
    answers: result.answers.map((a) => ({
      type: String(a.type),
      value: typeof (a as { data?: unknown }).data === 'string'
        ? String((a as { data?: unknown }).data)
        : JSON.stringify((a as { data?: unknown }).data),
      ttl: (a as { ttl?: number }).ttl ?? row.ttl,
    })),
    rcode: result.rcode,
    steered: result.steered,
    degraded: result.degraded,
  };
}
