/**
 * Cluster zone lifecycle (plans/self-reliance.md B2b) — the controller side of
 * `cluster-zone.ts`: the view behind Network › Geo-DNS › Cluster zone, the
 * audited switch, and the install-time seed from `SWARMY_CLUSTER_ZONE`.
 */
import { synthAllowList } from '@swarmy/dns';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { writeAudit } from './audit.service';
import { autoAddressBaseInfo, autoAddressZone } from './auto-address.service';
import { clusterNodeIps, clusterZoneRow, isClusterZone } from './cluster-zone';
import { checkDelegation } from './dns-zones.service';
import { dnsZoneRepo, geoDnsConfigRepo } from './geodns.repo';
import type { KvScope } from './kv-repo';
import { publicIpFromLabels } from './node.service';

export interface GlueRecord {
  name: string;
  type: 'NS' | 'A';
  value: string;
}

/** What the registrar (or the parent zone's DNS) needs: one NS per nameserver, plus its glue A. Pure. */
export function delegationGlue(zone: string, nameservers: ReadonlyArray<{ fqdn: string; ip: string }>): GlueRecord[] {
  return [
    ...nameservers.map((ns): GlueRecord => ({ name: zone, type: 'NS', value: ns.fqdn })),
    ...nameservers.filter((ns) => ns.ip).map((ns): GlueRecord => ({ name: ns.fqdn, type: 'A', value: ns.ip })),
  ];
}

export type AddressSource = 'own-zone' | 'cluster-zone' | 'configured' | 'public-convenience';

const PUBLIC_WILDCARD = /(^|\.)(sslip\.io|nip\.io)$/;

export interface ClusterZoneView {
  zoneId: string | null;
  /** The cluster zone, or null: apps then get a public convenience name (sslip.io). */
  zone: string | null;
  /** NS + glue records to add at the registrar, from the pinned nameservers. */
  glue: GlueRecord[];
  /** The base apps get addresses under right now (`5-9-10-200.apps.example.com`). */
  addressBase: string | null;
  source: AddressSource | null;
  /** Public IPv4s `<a-b-c-d>.<zone>` answers for (the cluster's own servers). */
  synthesized: string[];
}

export async function getClusterZone(ctx: OrgContext): Promise<ClusterZoneView> {
  const row = await clusterZoneRow(ctx, ctx.activeOrgId);
  const info = await autoAddressBaseInfo(ctx).catch(() => null);
  const own = await autoAddressZone(ctx);
  const source: AddressSource | null = !info
    ? null
    : own && info.base === own
      ? 'own-zone'
      : row && info.base.endsWith(`.${row.zone}`)
        ? 'cluster-zone'
        : PUBLIC_WILDCARD.test(info.base)
          ? 'public-convenience'
          : 'configured';
  const nameservers = (Array.isArray(row?.advertisedNodeIds) ? (row.advertisedNodeIds as string[]) : []).map((nodeId, i) => ({
    fqdn: `ns${i + 1}.${row!.zone}`,
    ip: publicIpFromLabels(ctx.hub.nodeInfoFor(nodeId)?.labels) ?? '',
  }));
  return {
    zoneId: row?.id ?? null,
    zone: row?.zone ?? null,
    glue: row ? delegationGlue(row.zone, nameservers) : [],
    addressBase: info?.base ?? null,
    source,
    synthesized: row ? synthAllowList(clusterNodeIps(ctx)) : [],
  };
}

/**
 * Make a zone the org's cluster zone (or stop it being one). Like app
 * addresses in a zone, turning it on needs the zone LIVE on swarmy's
 * nameservers — existing automatic addresses move onto it on the next
 * domain-verify tick, so it must already resolve. One per org.
 */
export async function setClusterZone(ctx: OrgContext, id: string, enabled: boolean): Promise<ClusterZoneView> {
  const row = await dnsZoneRepo.find(ctx, ctx.activeOrgId, id);
  if (!row) throw notFound('dnsZone', id);
  const settings = row.settings && typeof row.settings === 'object' ? (row.settings as Record<string, unknown>) : {};
  if (enabled) {
    if (row.mode !== 'swarmy-ns' || !row.enabled) {
      throw new Error(`${row.zone} must be enabled and served by swarmy's nameservers first`);
    }
    const delegation = await checkDelegation(ctx, id);
    if (!delegation.delegated) {
      throw new Error(
        `${row.zone} is not delegated to swarmy yet (public NS: ${delegation.publicNs.join(', ') || 'none'}). ` +
          `Add the NS and glue records first — apps would otherwise move onto names nobody can resolve.`,
      );
    }
    for (const other of await dnsZoneRepo.list(ctx, ctx.activeOrgId)) {
      if (other.id !== id && isClusterZone(other.settings)) {
        const { clusterZone: _drop, ...rest } = other.settings as Record<string, unknown>;
        await dnsZoneRepo.update(ctx, ctx.activeOrgId, other.id, { settings: rest });
      }
    }
  }
  const { clusterZone: _old, ...rest } = settings;
  await dnsZoneRepo.update(ctx, ctx.activeOrgId, id, { settings: enabled ? { ...rest, clusterZone: true } : rest });
  await writeAudit(ctx, {
    action: 'dns.setClusterZone',
    targetType: 'dnsZone',
    targetId: id,
    metadata: { zone: row.zone, enabled },
  });
  return getClusterZone(ctx);
}

const ZONE_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/**
 * Install-time seed (`install-swarmy.sh --zone` → `SWARMY_CLUSTER_ZONE`):
 * create the zone as the org's cluster zone and turn geo-DNS on. Only when
 * the zone doesn't exist yet — a fresh install has no addresses to break, and
 * a later dashboard change is never overridden on reboot (nor is a cluster
 * zone the org already has). Returns whether it created the zone.
 */
export async function ensureClusterZone(scope: KvScope, orgId: string, raw: string): Promise<boolean> {
  const zone = raw.trim().toLowerCase().replace(/\.+$/, '');
  if (!ZONE_RE.test(zone)) throw new Error(`${raw} is not a zone name (e.g. apps.example.com)`);
  const rows = await dnsZoneRepo.list(scope, orgId);
  if (rows.some((r) => r.zone === zone || isClusterZone(r.settings))) return false;
  const created = await dnsZoneRepo.create(scope, orgId, { zone, mode: 'swarmy-ns' });
  await dnsZoneRepo.update(scope, orgId, created.id, { enabled: true, settings: { clusterZone: true } });
  await geoDnsConfigRepo.update(scope, orgId, { enabled: true });
  return true;
}
