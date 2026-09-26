/**
 * "Add a domain" preview — what to create at the registrar for a host that is
 * NOT routed yet, from the same sources the status view uses once it is
 * (`expectedTarget` for the edges, `zoneFor` for a swarmy-served zone,
 * `dnsGuidance` for the records). Read-only: nothing is registered or gated.
 */
import { apexOf, dnsGuidance, isApex, isPrivateHost, normalizeHostname, type DnsGuidance } from '@swarmy/ingress';
import type { OrgContext } from '../context';
import { expectedTarget, zoneFor } from './domain-verify.service';
import { publicIpFromLabels, NODE_REGION_LABEL } from './node.service';

export interface DomainPlanEdge {
  ip: string;
  /** The server's hostname, when swarmy knows which server has this IP. */
  name: string | null;
  region: string | null;
}

export interface DomainPlanView {
  host: string;
  apex: string;
  isApex: boolean;
  /** Records to create at the registrar (A/AAAA per edge; tunnel CNAME; private note). */
  registrar: DnsGuidance;
  /**
   * The swarmy-served zone that contains the host (delegate NS once and every
   * host in it resolves to the nearest edge). Null when swarmy serves no zone
   * for it — "Let swarmy be the nameserver" is then unavailable.
   */
  nameserver: { zone: string; nameservers: Array<{ fqdn: string; ip: string }>; guidance: DnsGuidance } | null;
  edges: DomainPlanEdge[];
}

/** The record plan for a host before it is added. Pure over the org's live edges + zones. */
export async function previewDomainPlan(ctx: OrgContext, rawHost: string): Promise<DomainPlanView> {
  const host = normalizeHostname(rawHost);
  const expected = await expectedTarget(ctx);
  const priv = isPrivateHost(host);
  const registrar = dnsGuidance({ host, expected, cnameTarget: expected.cnameTarget, zone: null, private: priv });
  const zone = priv ? null : await zoneFor(ctx, host).catch(() => null);
  const nameserver = zone
    ? { zone: zone.zone, nameservers: zone.nameservers, guidance: dnsGuidance({ host, expected, cnameTarget: expected.cnameTarget, zone }) }
    : null;
  const nodes = await ctx.db.node.findMany({ where: { orgId: ctx.activeOrgId }, select: { id: true } });
  const byIp = new Map<string, { name: string | null; region: string | null }>();
  for (const n of nodes) {
    const info = ctx.hub.nodeInfoFor(n.id);
    const ip = publicIpFromLabels(info?.labels);
    if (ip && !byIp.has(ip)) byIp.set(ip, { name: info?.hostname ?? null, region: info?.labels?.[NODE_REGION_LABEL] ?? null });
  }
  return {
    host,
    apex: apexOf(host),
    isApex: isApex(host),
    registrar,
    nameserver,
    edges: expected.ips.map((ip) => ({ ip, name: byIp.get(ip)?.name ?? null, region: byIp.get(ip)?.region ?? null })),
  };
}
