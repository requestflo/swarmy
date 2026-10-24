/**
 * The cluster zone — plans/self-reliance.md B2(b). One swarmy-ns zone per org
 * (`settings.clusterZone`, set at install with `--zone` or on Network ›
 * Geo-DNS) that swarmy-dns serves as the org's own sslip.io:
 *
 *  - `<a-b-c-d>.<zone>` and names under it answer A a.b.c.d for the cluster's
 *    own public node addresses (`@swarmy/dns` synth.ts);
 *  - it is the automatic-address base (`wildcardBaseFrom`), so apps get
 *    `<svc>-<stack>.<edge-ip>.<zone>` — and those route names answer with the
 *    steered edges like every other host in the zone;
 *  - sslip.io stays only as the fallback for an org with no cluster zone.
 *
 * Leaf module (repo + hub reads only) so composition, auto addresses and the
 * ingress render can all import it without a cycle.
 */
import type { OrgContext } from '../context';
import { dnsZoneRepo, type DnsZoneRow } from './geodns.repo';
import type { KvScope } from './kv-repo';
import { publicIpFromLabels } from './node.service';

/** Installer `--zone` → the controller: the bootstrap org's cluster zone. */
export const CLUSTER_ZONE_ENV = 'SWARMY_CLUSTER_ZONE';

/** Does a zone row's settings flag it as the org's cluster zone? Pure. */
export function isClusterZone(settings: unknown): boolean {
  return Boolean(settings && typeof settings === 'object' && (settings as Record<string, unknown>).clusterZone === true);
}

/** The org's cluster zone row: enabled, served by swarmy-dns, flagged. */
export async function clusterZoneRow(scope: KvScope, orgId: string): Promise<DnsZoneRow | null> {
  const rows = await dnsZoneRepo.list(scope, orgId, { enabled: true, mode: 'swarmy-ns' }).catch(() => []);
  return rows.find((r) => isClusterZone(r.settings)) ?? null;
}

/** The org's cluster zone name, or null (→ the sslip.io fallback). */
export async function clusterZoneName(ctx: OrgContext): Promise<string | null> {
  return (await clusterZoneRow(ctx, ctx.activeOrgId))?.zone ?? null;
}

/**
 * Every public address the cluster owns — what the cluster zone may
 * synthesise. Last-known nodes are included, so a node blipping offline never
 * churns the zone (this is identity, not health). `@swarmy/dns` filters it to
 * public IPv4.
 */
export function clusterNodeIps(ctx: OrgContext, extra: readonly string[] = []): string[] {
  const ips = ctx.hub
    .nodeInventory(ctx.activeOrgId, true)
    .map((n) => publicIpFromLabels(n.labels))
    .filter((ip): ip is string => Boolean(ip));
  return [...new Set([...ips, ...extra])].sort();
}
