import type { DemoStore } from '../types';
import { apexOf, normalizeHost } from '@/components/domains/host-shape';

/**
 * Demo custom-domain checks: a believable walk through the controller's
 * lifecycle (waiting_dns → verified → issuing → active), one step per
 * "Check again". Mirrors `resolverChainLookup` (swarmy's own resolver first;
 * the public DoH resolvers only once it already sees an edge), `evaluateDns`
 * reasons, the per-edge TLS probe, and `nextCheckDelay` timing.
 */
export interface DemoCheck {
  /** 0 waiting · 1 propagating · 2 verified · 3 issuing · 4 active. */
  stage: number;
  /** What the name points at before the user fixes it (null = no record yet). */
  wrongIp: string | null;
  addedAt: number;
  lastCheckedAt: number;
  verifiedAt: number | null;
  manual?: boolean;
  /** Skipped by an admin before DNS was right: the answers stay what they were. */
  dnsStage?: number;
}

export interface DemoEdge {
  ip: string;
  name: string;
  region: string | null;
}

interface DemoNode {
  id: string;
  name: string;
  status: string;
  ingress?: boolean;
  publicIp?: string;
  region?: string;
}

/** The edges that terminate traffic: the pinned controller nodes, or every online ingress node per-node. */
export function demoEdges(s: DemoStore, topology: string, targetNodes: string[]): DemoEdge[] {
  const nodes = s.nodes as unknown as DemoNode[];
  const pick = topology === 'edge-per-node' ? nodes.filter((n) => n.ingress && n.status === 'online') : nodes.filter((n) => targetNodes.includes(n.id));
  const edges = pick.filter((n) => n.publicIp).map((n) => ({ ip: n.publicIp!, name: n.name, region: n.region ?? null }));
  return edges.length ? edges : [{ ip: '203.0.113.10', name: 'mgr-1', region: 'us-east' }];
}

const MIN = 60_000;
function delay(c: DemoCheck, now: number): number {
  if (c.verifiedAt === null) {
    const age = now - c.addedAt;
    return age < 10 * MIN ? 30_000 : age < 60 * MIN ? 2 * MIN : age < 24 * 60 * MIN ? 10 * MIN : 60 * MIN;
  }
  return c.stage < 4 ? MIN : 10 * MIN;
}

/** One step forward (a "Check again"). Skip jumps straight to verified. */
export function advance(c: DemoCheck, now: number, skip = false): DemoCheck {
  const stage = skip ? Math.max(c.stage, 2) : Math.min(4, c.stage + 1);
  const manual = c.manual || (skip && c.stage < 2);
  return { ...c, stage, lastCheckedAt: now, verifiedAt: c.verifiedAt ?? (stage >= 2 ? now : null), manual, dnsStage: manual ? (c.dnsStage ?? c.stage) : undefined };
}

function answer(resolver: string, ips: string[], edges: string[]) {
  return { resolver, a: ips, aaaa: [], cname: [], ...(ips.length ? {} : { nxdomain: true }), matches: ips.some((ip) => edges.includes(ip)) };
}

/** A `DomainStatusView` for this check stage. */
export function checkStatus(host: string, c: DemoCheck, edges: DemoEdge[], tls: string, companion: boolean) {
  const ips = edges.map((e) => e.ip);
  // The worker keeps checking on its own schedule (same answer until "Check again" moves it).
  const every = delay(c, c.lastCheckedAt);
  const last = c.lastCheckedAt + Math.floor(Math.max(0, Date.now() - c.lastCheckedAt) / every) * every;
  const old = companion || !c.wrongIp ? [] : [c.wrongIp];
  const stage = c.stage;
  const dnsStage = c.dnsStage ?? stage;
  const resolvers =
    dnsStage === 0 ? [answer('system', old, ips)] : dnsStage === 1 ? [answer('system', ips, ips), answer('1.1.1.1', ips, ips), answer('8.8.8.8', old, ips)] : ['system', '1.1.1.1', '8.8.8.8'].map((r) => answer(r, ips, ips));
  const seen = [...new Set(resolvers.flatMap((r) => r.a))];
  const expected = ips.join(' or ');
  const reason =
    stage === 0
      ? old.length ? `${host} points at ${old.join(', ')} — expected ${expected}.` : `No DNS record for ${host} yet.`
      : stage === 1
        ? `Still propagating: 8.8.8.8 sees ${old.join(', ') || 'nothing'}.`
        : tls === 'off' ? 'Serving over plain HTTP (TLS is off).'
          : stage === 2 ? 'DNS verified — requesting a certificate.'
            : stage === 3 ? 'Requesting a certificate from Let’s Encrypt…'
              : `Secured by Let’s Encrypt until ${new Date(c.lastCheckedAt + 90 * 86_400_000).toISOString().slice(0, 10)}.`;
  const state = stage < 2 ? 'waiting_dns' : tls === 'off' ? 'active' : stage === 2 ? 'verified' : stage === 3 ? 'issuing' : 'active';
  const temp = 'the edge is serving a temporary/self-signed certificate (a public one has not been issued yet)';
  const certificate =
    tls === 'off' || stage < 3
      ? null
      : stage === 3
        ? { issuer: null, expiresAt: null, error: temp, edges: ips.map((ip) => ({ ip, ok: false, error: temp })), checkedAt: new Date(c.lastCheckedAt).toISOString() }
        : { issuer: 'Let’s Encrypt', expiresAt: new Date(c.lastCheckedAt + 90 * 86_400_000).toISOString(), error: null, edges: ips.map((ip) => ({ ip, ok: true })), checkedAt: new Date(c.lastCheckedAt).toISOString() };
  return {
    host,
    state: state as 'waiting_dns' | 'verified' | 'issuing' | 'active',
    reason,
    warnings: [] as string[],
    gated: stage < 2 && tls === 'auto',
    verifiedAt: c.verifiedAt ? new Date(c.verifiedAt).toISOString() : null,
    verifiedManually: !!c.manual,
    lastCheckedAt: new Date(last).toISOString(),
    nextCheckAt: new Date(last + every).toISOString(),
    dns: { a: seen, aaaa: [], cname: [], matched: seen.filter((ip) => ips.includes(ip)), resolvers },
    certificate,
  };
}

/** Mirrors `dnsGuidance` for a host that isn't in a swarmy zone: one A record per edge. */
export function registrarGuidance(rawHost: string, edges: DemoEdge[]) {
  const host = normalizeHost(rawHost);
  const apex = apexOf(host);
  const label = host === apex ? '@' : host.slice(0, -(apex.length + 1));
  const multi = edges.length > 1 ? ' Add one record per address — visitors are spread across the edges.' : '';
  return {
    mode: 'records' as const,
    summary: `At your DNS provider, point ${host} at swarmy’s edge.${multi} Remove any other A/AAAA records for this name.`,
    records: edges.map((e) => ({ type: 'A' as const, name: host, label, value: e.ip })),
    alternatives: [] as Array<{ type: 'CNAME'; name: string; label: string; value: string; note?: string }>,
  };
}
