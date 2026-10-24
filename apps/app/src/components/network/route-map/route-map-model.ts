import { TRAFFIC_NOW_WINDOW_MINUTES, type NodeSummary, type ServiceSummary, type TrafficNowView } from '@swarmy/core';
import type { Tone } from '@/components/calm';
import type { HostVisits } from '@/lib/host-visits';
import { domainSay, type HubDomain } from '../use-network';

/** One edge on the map: a server running (or marked for) the front door. */
export interface MapEdge {
  id: string;
  name: string;
  region: string | null;
  ip: string | null;
  /** Requests a minute over the last 5 minutes (`traffic.now`); null = no number yet. */
  perMin: number | null;
  /** The server is online, so DNS can send visitors to it. */
  healthy: boolean;
}

/** One app service that an address opens. */
export interface MapApp {
  id: string;
  app: string;
  service: string;
  hosts: string[];
  /** Server names its copies run on; undefined while placement is still loading. */
  where: string[] | undefined;
  tone: Tone;
}

export interface RouteMap {
  visitors: { perMin: number | null; regions: Array<{ region: string | null; perMin: number }> };
  edges: MapEdge[];
  apps: MapApp[];
}

const RANK: Record<Tone, number> = { bad: 0, warn: 1, info: 2, mesh: 3, idle: 4, ok: 5 };

/** `storefront_web` → `web` (the swarm name carries the app prefix). */
export function shortService(stack: string, name: string): string {
  return name.startsWith(`${stack}_`) ? name.slice(stack.length + 1) : name;
}

/** Visitor → DNS → edge → app, from live truth only: `traffic.now`, the servers and where each service runs. */
export function buildRouteMap(input: {
  domains: HubDomain[];
  traffic: TrafficNowView;
  nodes: NodeSummary[];
  servicesByNode: Map<string, ServiceSummary[]> | undefined;
}): RouteMap {
  const byId = new Map(input.nodes.map((n) => [n.id, n] as const));
  const edges: MapEdge[] = input.traffic.regions.flatMap((r) =>
    r.edges.map((e) => ({
      id: e.nodeId,
      name: e.name,
      region: e.region,
      ip: byId.get(e.nodeId)?.publicIp ?? null,
      perMin: e.requestsPerMin,
      healthy: byId.get(e.nodeId)?.status === 'online',
    })),
  );
  const apps = new Map<string, MapApp>();
  for (const d of input.domains) {
    const tone = domainSay(d).tone;
    const cur = apps.get(d.serviceId);
    if (cur) {
      cur.hosts.push(d.host);
      if (RANK[tone] < RANK[cur.tone]) cur.tone = tone;
      continue;
    }
    const where = input.servicesByNode
      ? input.nodes.filter((n) => input.servicesByNode!.get(n.id)?.some((s) => s.id === d.serviceId)).map((n) => n.name)
      : undefined;
    apps.set(d.serviceId, { id: d.serviceId, app: d.stack, service: shortService(d.stack, d.serviceName), hosts: [d.host], where, tone });
  }
  const regions = input.traffic.regions.flatMap((r) => (r.requestsPerMin === null ? [] : [{ region: r.region, perMin: r.requestsPerMin }]));
  return { visitors: { perMin: input.traffic.totals.requestsPerMin, regions }, edges, apps: [...apps.values()] };
}

/** Is the address on the edges right now (served, and not withheld until its DNS verifies)? */
export function isServed(d: HubDomain): boolean {
  return d.serving && !d.status?.gated;
}

export interface LitPath {
  edges: Set<string>;
  app: string | null;
  served: boolean;
  /** The address's own visits a minute (`traffic.now.hosts`); null = no number for it. */
  perMin: number | null;
  /** Its visits a minute on each edge that carried them. */
  byEdge: Map<string, number>;
}

/**
 * The path one address takes: the healthy edges (every edge carries every
 * address), its app, and — when the edge counted it — its own rate, split by edge.
 */
export function litPath(map: RouteMap, d: HubDomain | null, visits: HostVisits | null = null): LitPath | null {
  if (!d) return null;
  const served = isServed(d);
  return {
    edges: new Set(served ? map.edges.filter((e) => e.healthy).map((e) => e.id) : []),
    app: d.serviceId,
    served,
    perMin: served && visits ? visits.perMin : null,
    byEdge: new Map(served && visits ? visits.edges.map((e) => [e.nodeId, e.requestsPerMin] as const) : []),
  };
}

/** The sentence under the map for the lit address. */
export function litSay(map: RouteMap, d: HubDomain | null, lit: LitPath | null): string {
  if (!d || !lit) return 'Pick an address to light up the way a visit takes.';
  if (!lit.served) return `${d.host} isn't on your edges yet: ${d.serving ? 'it waits for its address record' : 'the front door is off'}.`;
  const opens = `${d.host} opens ${d.stack} / ${shortService(d.stack, d.serviceName)}`;
  const n = lit.edges.size;
  const any = `any of your ${n} healthy edge${n === 1 ? '' : 's'}`;
  if (lit.perMin === null) return `${opens}. ${any[0]!.toUpperCase()}${any.slice(1)} can take the visit.`;
  if (lit.perMin === 0) return `${opens}. No visits in the last ${TRAFFIC_NOW_WINDOW_MINUTES} minutes; ${any} can take one.`;
  const name = (id: string): string => map.edges.find((e) => e.id === id)?.name ?? id;
  const parts = [...lit.byEdge.entries()].map(([id, v]) => `${perMinText(v)} through ${name(id)}`);
  const via =
    parts.length === 1
      ? `all through ${name([...lit.byEdge.keys()][0]!)}`
      : parts.length <= 3
        ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
        : `over ${parts.length} edges`;
  return `${opens}: ${perMinText(lit.perMin)} visits a minute, ${via}.`;
}

/** "434" / "1.2k" — a rate as a short mono number. */
export function perMinText(n: number): string {
  return n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`;
}
