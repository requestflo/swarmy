import type { TrafficCell } from './edge-traffic';

/** One edge's share of an address's visits. */
export interface TrafficHostEdgeView {
  nodeId: string;
  requestsPerMin: number;
}

/**
 * One address at the edge right now (`traffic.now.hosts`). The ring is keyed
 * per host, so this is the edge's own count for exactly this host — not its
 * app's. `host` is normalised as the edge reported it (lowercase, no port);
 * `_other` (EDGE_OVERFLOW_HOST) holds the hosts an edge folded past its cap.
 */
export interface TrafficHostView {
  host: string;
  /** App (stack) whose route owns the host; null = no app's route ("other"). */
  app: string | null;
  requestsPerMin: number;
  errors5xxPerMin: number;
  /** errors5xx / requests (0..1); null with no requests. */
  errorShare: number | null;
  /** Its rate on each edge that carried it in the window, busiest first. */
  edges: TrafficHostEdgeView[];
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Per host over the window `[start, end)`: each cell's count divides by the
 * minutes its edge covered, exactly as the per-app fold does, so an app's
 * hosts add up to the app's rate. Cells outside the window, or from an edge
 * with no covered minute, are dropped. Busiest first, then by host.
 */
export function aggregateTrafficHosts(args: {
  cells: readonly TrafficCell[];
  /** Edge → minutes (fractional) of the window its reports covered. */
  covered: ReadonlyMap<string, number>;
  appOf: (host: string) => string | null;
  start: number;
  end: number;
}): TrafficHostView[] {
  const perHost = new Map<string, { requests: number; errors5xx: number; edges: Map<string, number> }>();
  for (const c of args.cells) {
    if (c.t < args.start || c.t >= args.end) continue;
    const mins = args.covered.get(c.nodeId);
    if (!mins) continue;
    const h = perHost.get(c.host) ?? { requests: 0, errors5xx: 0, edges: new Map<string, number>() };
    h.requests += c.requests / mins;
    h.errors5xx += c.errors5xx / mins;
    h.edges.set(c.nodeId, (h.edges.get(c.nodeId) ?? 0) + c.requests / mins);
    perHost.set(c.host, h);
  }
  return [...perHost.entries()]
    .map(([host, h]) => ({
      host,
      app: args.appOf(host),
      requestsPerMin: round1(h.requests),
      errors5xxPerMin: round1(h.errors5xx),
      errorShare: h.requests > 0 ? Math.round((h.errors5xx / h.requests) * 10_000) / 10_000 : null,
      edges: [...h.edges.entries()]
        .map(([nodeId, r]) => ({ nodeId, requestsPerMin: round1(r) }))
        .sort((a, b) => b.requestsPerMin - a.requestsPerMin || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0)),
    }))
    .sort((a, b) => b.requestsPerMin - a.requestsPerMin || (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
}
