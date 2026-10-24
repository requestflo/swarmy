import { EDGE_OVERFLOW_HOST, type TrafficHostEdgeView, type TrafficNowView } from '@swarmy/core';

/** One address's visits at the edge right now (`traffic.now.hosts`). */
export interface HostVisits {
  perMin: number;
  errors5xxPerMin: number;
  /** Its rate on each edge that carried it, busiest first. */
  edges: TrafficHostEdgeView[];
  windowMinutes: number;
}

const norm = (h: string): string => h.trim().toLowerCase().replace(/\.$/, '');

/**
 * An address's visits a minute from `traffic.now`, or null when there's no
 * honest number: nothing reported yet, the address doesn't go through the
 * Caddy edge (a tunnel route — `viaEdge` false), or an edge folded some
 * hosts into `_other` so a missing one may be inside it. Zero only when the
 * edges reported and counted none for it. A `*.zone` address adds up every
 * host it covers (one label deep, as the route matches).
 */
export function hostVisits(traffic: TrafficNowView | undefined, host: string, viaEdge = true): HostVisits | null {
  if (!traffic || traffic.totals.state !== 'reporting' || !viaEdge) return null;
  const h = norm(host);
  const wild = h.startsWith('*.') ? h.slice(1) : null;
  const rows = traffic.hosts.filter((r) => (wild ? r.host.indexOf('.') > 0 && r.host.slice(r.host.indexOf('.')) === wild : r.host === h));
  if (rows.length === 0) {
    if (traffic.hosts.some((r) => r.host === EDGE_OVERFLOW_HOST)) return null;
    return { perMin: 0, errors5xxPerMin: 0, edges: [], windowMinutes: traffic.windowMinutes };
  }
  const byEdge = new Map<string, number>();
  for (const r of rows) for (const e of r.edges) byEdge.set(e.nodeId, (byEdge.get(e.nodeId) ?? 0) + e.requestsPerMin);
  const r1 = (n: number): number => Math.round(n * 10) / 10;
  return {
    perMin: r1(rows.reduce((n, r) => n + r.requestsPerMin, 0)),
    errors5xxPerMin: r1(rows.reduce((n, r) => n + r.errors5xxPerMin, 0)),
    edges: [...byEdge.entries()].map(([nodeId, v]) => ({ nodeId, requestsPerMin: r1(v) })).sort((a, b) => b.requestsPerMin - a.requestsPerMin),
    windowMinutes: traffic.windowMinutes,
  };
}

/** Does this address go through the Caddy edge (where visits are counted)? The route's own driver, else the org's. */
export function countedAtEdge(routeDriver: string | null | undefined, orgDriver: string | null | undefined): boolean {
  return (routeDriver || orgDriver) === 'caddy';
}
