import type { PromSample } from './prometheus-text';
import type { EdgeHostTraffic, EdgeTrafficSample } from './protocol/stats';
import { CADDY_DURATION_COUNT_METRIC, EDGE_OVERFLOW_HOST, normalizeTrafficHost, type EdgeScrapeState } from './edge-traffic';
import { addLatency, latencyCount, type LatencyBuckets } from './edge-latency';

/**
 * Latency and blocked answers out of a Caddy scrape — the agent half.
 *
 * Both come from `caddy_http_request_duration_seconds`, the histogram Caddy
 * keeps per `{server, handler, code, method, host}` once `metrics { per_host }`
 * is on (Caddy 2.11: one series set per top-level route). The request counter
 * has no `code` label, so 403/429 are read from the histogram's `_count`.
 * Requests a protection drops with `abort` (IP, country, bot and required-header
 * rules) never reach Caddy's metrics: they are not counted anywhere.
 */
export const CADDY_DURATION_BUCKET_METRIC = 'caddy_http_request_duration_seconds_bucket';

/** One host's cumulative extras in one scrape. */
export interface CaddyHostExtras {
  status403: number;
  status429: number;
  /** Cumulative bucket counts by upper bound (seconds; Infinity = +Inf), 101 upgrades left out. */
  cumulative: Map<number, number>;
}

const parseLe = (le: string | undefined): number | undefined => {
  if (le === '+Inf' || le === 'Inf') return Number.POSITIVE_INFINITY;
  const n = le === undefined ? Number.NaN : Number(le);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

/**
 * Per host: 403 and 429 answers and the duration buckets. Like the request
 * counter, the series are summed over code/method per `(server, handler)` and
 * the busiest handler — the outermost route every request passes — stands for
 * the host (summing handlers would double count). WebSocket upgrades (101)
 * stay out of the buckets: their "duration" is the whole connection.
 */
export function caddyHostExtras(samples: readonly PromSample[]): Map<string, CaddyHostExtras> {
  const byHost = new Map<string, Map<string, { total: number; s403: number; s429: number; cum: Map<number, number> }>>();
  for (const s of samples) {
    const isCount = s.name === CADDY_DURATION_COUNT_METRIC;
    if ((!isCount && s.name !== CADDY_DURATION_BUCKET_METRIC) || s.labels.host === undefined) continue;
    if (!Number.isFinite(s.value) || s.value < 0) continue;
    const host = normalizeTrafficHost(s.labels.host);
    const key = `${s.labels.server ?? ''}\u0000${s.labels.handler ?? ''}`;
    const handlers = byHost.get(host) ?? new Map();
    byHost.set(host, handlers);
    const acc = handlers.get(key) ?? { total: 0, s403: 0, s429: 0, cum: new Map<number, number>() };
    handlers.set(key, acc);
    if (isCount) {
      acc.total += s.value;
      if (s.labels.code === '403') acc.s403 += s.value;
      if (s.labels.code === '429') acc.s429 += s.value;
      continue;
    }
    const le = parseLe(s.labels.le);
    if (le === undefined || s.labels.code === '101') continue;
    acc.cum.set(le, (acc.cum.get(le) ?? 0) + s.value);
  }
  const out = new Map<string, CaddyHostExtras>();
  for (const [host, handlers] of byHost) {
    const all = [...handlers.values()];
    const busiest = all.reduce((a, b) => (b.total > a.total ? b : a));
    out.set(host, {
      status403: Math.round(Math.max(...all.map((a) => a.s403))),
      status429: Math.round(Math.max(...all.map((a) => a.s429))),
      cumulative: new Map([...busiest.cum].map(([le, n]) => [le, Math.round(n)] as const)),
    });
  }
  return out;
}

/** What one host added between two scrapes. */
export interface HostExtrasDelta {
  status403: number;
  status429: number;
  latency?: LatencyBuckets;
}

/**
 * Delta between two scrapes of one host. Any value that went DOWN (or a
 * caller-detected reset) means the series restarted: the current values are
 * the delta. Cumulative buckets become per-bucket counts.
 */
export function hostExtrasDelta(prev: CaddyHostExtras | undefined, curr: CaddyHostExtras, reset = false): HostExtrasDelta {
  const down =
    !!prev &&
    (curr.status403 < prev.status403 ||
      curr.status429 < prev.status429 ||
      [...curr.cumulative].some(([le, n]) => n < (prev.cumulative.get(le) ?? 0)));
  const base = reset || down || !prev ? undefined : prev;
  const les = [...curr.cumulative.keys()].sort((a, b) => a - b);
  const cumDelta = les.map((le) => curr.cumulative.get(le)! - (base?.cumulative.get(le) ?? 0));
  const bounds = les.filter((le) => Number.isFinite(le));
  const counts = new Array<number>(bounds.length + 1).fill(0);
  les.forEach((le, i) => {
    const at = Number.isFinite(le) ? i : bounds.length;
    counts[at] = Math.max(0, cumDelta[i]! - (i > 0 ? cumDelta[i - 1]! : 0));
  });
  const out: HostExtrasDelta = {
    status403: curr.status403 - (base?.status403 ?? 0),
    status429: curr.status429 - (base?.status429 ?? 0),
  };
  if (counts.some((c) => c > 0)) out.latency = { bounds, counts };
  return out;
}

/**
 * Decorate a `metrics.edge` delta with each host's extras. A host folded
 * into `_other` past the per-scrape cap adds to `_other`. Blocked answers
 * never exceed the requests they are part of.
 */
export function withEdgeExtras(
  sample: EdgeTrafficSample | undefined,
  prev: EdgeScrapeState | undefined,
  curr: EdgeScrapeState,
): EdgeTrafficSample | undefined {
  if (!sample || !curr.extras) return sample;
  const before = prev?.extras;
  const restarted = prev?.startedAt !== undefined && curr.startedAt !== undefined && prev.startedAt !== curr.startedAt;
  const hosts: EdgeHostTraffic[] = sample.hosts.map((h) => ({ ...h }));
  const byHost = new Map(hosts.map((h) => [h.host, h] as const));
  const other = byHost.get(EDGE_OVERFLOW_HOST);
  for (const [host, ex] of curr.extras) {
    const pc = prev?.counters.get(host);
    const cc = curr.counters.get(host);
    const moved = !pc || !cc || cc.requests !== pc.requests || restarted;
    const target = byHost.get(host) ?? (moved ? other : undefined);
    if (!target) continue;
    const d = hostExtrasDelta(before?.get(host), ex, restarted || (!!pc && !!cc && cc.requests < pc.requests));
    target.status403 = (target.status403 ?? 0) + d.status403;
    target.status429 = (target.status429 ?? 0) + d.status429;
    const lat = addLatency(target.latency, d.latency);
    if (lat && latencyCount(lat) > 0) target.latency = lat;
  }
  for (const h of hosts) {
    if (h.status403 !== undefined) h.status403 = Math.min(h.status403, h.requests);
    if (h.status429 !== undefined) h.status429 = Math.min(h.status429, h.requests - (h.status403 ?? 0));
  }
  return { ...sample, hosts };
}
