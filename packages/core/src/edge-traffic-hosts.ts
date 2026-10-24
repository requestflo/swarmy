import type { TrafficCell } from './edge-traffic';
import { addLatency, latencyView, type LatencyBuckets, type LatencyView } from './edge-latency';

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
export interface TrafficHostView extends Partial<LatencyView> {
  host: string;
  /** App (stack) whose route owns the host; null = no app's route ("other"). */
  app: string | null;
  requestsPerMin: number;
  errors5xxPerMin: number;
  /** errors5xx / requests (0..1); null with no requests. */
  errorShare: number | null;
  /**
   * 403 + 429 answers a minute at this host — what the protections turned
   * away with a status (scanner paths, WAF-lite → 403; rate limit → 429), plus
   * any 403/429 the app sent itself: Caddy's `code` label can't tell them
   * apart. Rules that drop the connection (`abort`) aren't counted. Null = no
   * edge reported status codes for it (an older agent).
   */
  blockedPerMin?: number | null;
  /** Of those, the 403s and the 429s. */
  forbiddenPerMin?: number | null;
  tooManyPerMin?: number | null;
  /** Its rate on each edge that carried it in the window, busiest first. */
  edges: TrafficHostEdgeView[];
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

interface HostAcc {
  requests: number;
  errors5xx: number;
  s403?: number;
  s429?: number;
  latency?: LatencyBuckets;
  edges: Map<string, number>;
}

/**
 * Per host over the window `[start, end)`: each cell's count divides by the
 * minutes its edge covered, exactly as the per-app fold does, so an app's
 * hosts add up to the app's rate. Latency merges the host's duration buckets
 * across every edge (percentiles of the merged counts, never an average of
 * percentiles). Cells outside the window, or from an edge with no covered
 * minute, are dropped. Busiest first, then by host.
 */
export function aggregateTrafficHosts(args: {
  cells: readonly TrafficCell[];
  /** Edge → minutes (fractional) of the window its reports covered. */
  covered: ReadonlyMap<string, number>;
  appOf: (host: string) => string | null;
  start: number;
  end: number;
}): TrafficHostView[] {
  const perHost = new Map<string, HostAcc>();
  for (const c of args.cells) {
    if (c.t < args.start || c.t >= args.end) continue;
    const mins = args.covered.get(c.nodeId);
    if (!mins) continue;
    const h = perHost.get(c.host) ?? { requests: 0, errors5xx: 0, edges: new Map<string, number>() };
    h.requests += c.requests / mins;
    h.errors5xx += c.errors5xx / mins;
    if (c.status403 !== undefined) h.s403 = (h.s403 ?? 0) + c.status403 / mins;
    if (c.status429 !== undefined) h.s429 = (h.s429 ?? 0) + c.status429 / mins;
    h.latency = addLatency(h.latency, c.latency);
    h.edges.set(c.nodeId, (h.edges.get(c.nodeId) ?? 0) + c.requests / mins);
    perHost.set(c.host, h);
  }
  return [...perHost.entries()]
    .map(([host, h]) => {
      const reported = h.s403 !== undefined || h.s429 !== undefined;
      return {
        host,
        app: args.appOf(host),
        requestsPerMin: round1(h.requests),
        errors5xxPerMin: round1(h.errors5xx),
        errorShare: h.requests > 0 ? Math.round((h.errors5xx / h.requests) * 10_000) / 10_000 : null,
        blockedPerMin: reported ? round1((h.s403 ?? 0) + (h.s429 ?? 0)) : null,
        forbiddenPerMin: reported ? round1(h.s403 ?? 0) : null,
        tooManyPerMin: reported ? round1(h.s429 ?? 0) : null,
        ...latencyView(h.latency),
        edges: [...h.edges.entries()]
          .map(([nodeId, r]) => ({ nodeId, requestsPerMin: round1(r) }))
          .sort((a, b) => b.requestsPerMin - a.requestsPerMin || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0)),
      };
    })
    .sort((a, b) => b.requestsPerMin - a.requestsPerMin || (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
}
