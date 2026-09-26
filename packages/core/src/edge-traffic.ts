import { z } from 'zod';
import type { PromSample } from './prometheus-text';
import type { EdgeTrafficSample } from './protocol/stats';

/**
 * Per-edge request counting (Q4) — the pure half.
 *
 *   agent:      Caddy /metrics → {@link caddyHostCounters} → {@link edgeTrafficDelta}
 *               → `metrics.edge` (per-host deltas since the last scrape)
 *   controller: {@link EdgeTrafficRing} (1-minute buckets, last 6 h, in memory)
 *               → {@link rollupRing} (5-minute rows persisted for 7 days)
 *               → {@link aggregateTrafficNow} / {@link bucketTrafficSeries}
 *
 * Numbers only: plain-words phrasing ("434 visitors a minute in Europe") is a
 * UI concern. "No data" is always `null` + a state, never a fake zero.
 */

// ── agent side: counters out of a Caddy scrape ─────────────────────────────

export interface HostCounter {
  requests: number;
  errors5xx: number;
}

/** Caddy's per-request counter (`metrics { per_host }` adds the `host` label). */
export const CADDY_REQUESTS_METRIC = 'caddy_http_requests_total';
/** Histogram count carrying the `code` label — the 5xx source when the counter has none. */
export const CADDY_DURATION_COUNT_METRIC = 'caddy_http_request_duration_seconds_count';
/** Go process collector: changes when Caddy restarts (a whole-counter reset). */
export const PROCESS_START_METRIC = 'process_start_time_seconds';

/** Lower-case, drop a trailing dot and a `:port`. `''` stays `''` (Caddy's catch-all). */
export function normalizeTrafficHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith('[')) return h; // IPv6 literal — leave as reported
  const colon = h.lastIndexOf(':');
  if (colon > 0 && /^\d+$/.test(h.slice(colon + 1))) h = h.slice(0, colon);
  return h.replace(/\.$/, '');
}

/**
 * Cumulative per-host counters from one Caddy scrape.
 *
 * Caddy instruments each HTTP handler, so one request that passes a
 * `subroute` and then a `reverse_proxy` increments BOTH series. Per host we
 * therefore sum over the non-handler labels, then take the LARGEST handler
 * series — the outermost handler every request of that site passes through
 * — instead of summing handlers (which would double count).
 *
 * Requests come from `caddy_http_requests_total`; 5xx from its `code` label
 * when present, else from `caddy_http_request_duration_seconds_count{code}`.
 * If the counter is missing entirely, the histogram count stands in for it.
 */
export function caddyHostCounters(samples: readonly PromSample[]): Map<string, HostCounter> {
  // host → handlerKey → { total, e5xx }
  const req = new Map<string, Map<string, { total: number; e5xx: number; coded: boolean }>>();
  const dur = new Map<string, Map<string, { total: number; e5xx: number }>>();
  for (const s of samples) {
    if (!Number.isFinite(s.value) || s.value < 0) continue;
    const isReq = s.name === CADDY_REQUESTS_METRIC;
    if (!isReq && s.name !== CADDY_DURATION_COUNT_METRIC) continue;
    if (s.labels.host === undefined) continue;
    const host = normalizeTrafficHost(s.labels.host);
    const handlerKey = `${s.labels.server ?? ''}\u0000${s.labels.handler ?? ''}`;
    const is5xx = typeof s.labels.code === 'string' && s.labels.code.startsWith('5');
    const target = isReq ? req : dur;
    const byHandler = target.get(host) ?? new Map();
    target.set(host, byHandler);
    const acc = byHandler.get(handlerKey) ?? { total: 0, e5xx: 0, coded: false };
    acc.total += s.value;
    if (is5xx) acc.e5xx += s.value;
    if (isReq && s.labels.code !== undefined) acc.coded = true;
    byHandler.set(handlerKey, acc);
  }
  const maxOf = (m: Map<string, { total: number; e5xx: number }> | undefined) => {
    let total = 0;
    let e5xx = 0;
    for (const v of m?.values() ?? []) {
      total = Math.max(total, v.total);
      e5xx = Math.max(e5xx, v.e5xx);
    }
    return { total, e5xx };
  };
  const out = new Map<string, HostCounter>();
  for (const host of new Set([...req.keys(), ...dur.keys()])) {
    const r = req.get(host);
    const d = maxOf(dur.get(host));
    const rm = maxOf(r);
    const coded = [...(r?.values() ?? [])].some((v) => v.coded);
    const requests = r ? rm.total : d.total;
    const errors5xx = r && coded ? rm.e5xx : d.e5xx;
    out.set(host, { requests: Math.round(requests), errors5xx: Math.round(Math.min(errors5xx, requests)) });
  }
  return out;
}

/** Caddy's process start time from a scrape (undefined when not exported). */
export function processStartTime(samples: readonly PromSample[]): number | undefined {
  return samples.find((s) => s.name === PROCESS_START_METRIC && Number.isFinite(s.value))?.value;
}

/** One scrape's cumulative state, kept by the agent between scrapes. */
export interface EdgeScrapeState {
  /** Wall-clock ms of the scrape. */
  at: number;
  /** Caddy process start (resets every counter when it changes). */
  startedAt?: number;
  counters: Map<string, HostCounter>;
}

/** Per-scrape host cap — a flood of junk Host headers must not blow up the frame. */
export const EDGE_MAX_HOSTS = 200;
/** Hosts past the cap are folded into this one (the controller's "other" bucket). */
export const EDGE_OVERFLOW_HOST = '_other';

function counterDelta(prev: number | undefined, curr: number, reset: boolean): number {
  // A counter that went DOWN restarted (Caddy restart / series re-created):
  // everything it holds now accrued since the reset. Same when the process
  // start time moved. A brand-new series started at zero: its value is the delta.
  if (reset || prev === undefined || curr < prev) return curr;
  return curr - prev;
}

/**
 * Deltas between two scrapes, as the `metrics.edge` payload. Undefined on the
 * first scrape (no baseline) or a non-advancing clock. Hosts with no new
 * requests are omitted; an empty `hosts` still means "reporting, no traffic".
 */
export function edgeTrafficDelta(
  prev: EdgeScrapeState | undefined,
  curr: EdgeScrapeState,
  maxHosts = EDGE_MAX_HOSTS,
): EdgeTrafficSample | undefined {
  if (!prev) return undefined;
  const intervalSec = (curr.at - prev.at) / 1000;
  if (!(intervalSec > 0)) return undefined;
  const restarted =
    prev.startedAt !== undefined && curr.startedAt !== undefined && prev.startedAt !== curr.startedAt;
  const hosts: Array<{ host: string; requests: number; errors5xx: number }> = [];
  for (const [host, c] of curr.counters) {
    const p = prev.counters.get(host);
    const reset = restarted || (p !== undefined && c.requests < p.requests);
    const requests = counterDelta(p?.requests, c.requests, reset);
    const errors5xx = Math.min(requests, counterDelta(p?.errors5xx, c.errors5xx, reset || (p !== undefined && c.errors5xx < p.errors5xx)));
    if (requests > 0 || errors5xx > 0) hosts.push({ host, requests, errors5xx });
  }
  hosts.sort((a, b) => b.requests - a.requests || (a.host < b.host ? -1 : 1));
  let kept = hosts;
  if (hosts.length > maxHosts) {
    kept = hosts.slice(0, maxHosts - 1);
    const rest = hosts.slice(maxHosts - 1);
    const existing = kept.findIndex((h) => h.host === EDGE_OVERFLOW_HOST);
    const folded = {
      host: EDGE_OVERFLOW_HOST,
      requests: rest.reduce((n, h) => n + h.requests, 0),
      errors5xx: rest.reduce((n, h) => n + h.errors5xx, 0),
    };
    if (existing >= 0) {
      kept[existing] = {
        host: EDGE_OVERFLOW_HOST,
        requests: kept[existing]!.requests + folded.requests,
        errors5xx: kept[existing]!.errors5xx + folded.errors5xx,
      };
    } else kept.push(folded);
  }
  return { sampledAt: curr.at, intervalSec, hosts: kept };
}

// ── controller side: the 1-minute ring ─────────────────────────────────────

export const MINUTE_MS = 60_000;
/** The in-memory ring covers the last 6 hours. */
export const TRAFFIC_RING_MINUTES = 360;
/** Persisted rollup width. */
export const TRAFFIC_ROLLUP_MS = 5 * MINUTE_MS;
/** Persisted rollups are kept for 7 days. */
export const TRAFFIC_ROLLUP_RETENTION_MS = 7 * 24 * 60 * MINUTE_MS;
/** "Right now" = the last 5 complete minutes. */
export const TRAFFIC_NOW_WINDOW_MINUTES = 5;
/** An edge with no report for this long reads as stale. */
export const TRAFFIC_STALE_MS = 3 * MINUTE_MS;

export const minuteOf = (ms: number): number => Math.floor(ms / MINUTE_MS) * MINUTE_MS;

export interface TrafficCell {
  /** Bucket start (ms). */
  t: number;
  nodeId: string;
  host: string;
  requests: number;
  errors5xx: number;
}

export interface EdgeReportSpan {
  /** When the edge's first `metrics.edge` arrived (controller clock). */
  firstAt: number;
  /** When its latest one arrived. */
  lastAt: number;
}

interface OrgRing {
  /** minute → `${nodeId}\0${host}` → counts */
  minutes: Map<number, Map<string, HostCounter>>;
  /** minute → node → ms of that minute its reports covered (zero traffic ≠ no data) */
  coverage: Map<number, Map<string, number>>;
  reports: Map<string, EdgeReportSpan>;
}

/**
 * Split integer `n` by `weights` (largest remainder): shares sum to exactly
 * `n`, so spreading a delta over minutes never gains or loses a request.
 */
export function apportion(n: number, weights: readonly number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  if (n === 0 || total <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (n * w) / total);
  const out = exact.map(Math.floor);
  let left = n - out.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, r: x - Math.floor(x) }))
    .sort((a, b) => b.r - a.r || b.i - a.i);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i]! += 1;
    left--;
  }
  return out;
}

/**
 * Controller-side 1-minute ring, per org, for the last 6 hours. Samples are
 * placed on the CONTROLLER's clock (receive time) so agent clock skew cannot
 * push buckets into the future. A delta covers `[receivedAt - intervalSec,
 * receivedAt]` and is split over the minutes it overlaps in proportion to the
 * overlap (a 15 s delta straddling a minute boundary, or an agent that
 * reconnected after a gap).
 */
export class EdgeTrafficRing {
  private readonly orgs = new Map<string, OrgRing>();
  constructor(private readonly retainMinutes = TRAFFIC_RING_MINUTES) {}

  private org(orgId: string): OrgRing {
    let o = this.orgs.get(orgId);
    if (!o) {
      o = { minutes: new Map(), coverage: new Map(), reports: new Map() };
      this.orgs.set(orgId, o);
    }
    return o;
  }

  orgIds(): string[] {
    return [...this.orgs.keys()];
  }

  record(orgId: string, nodeId: string, sample: EdgeTrafficSample, receivedAt: number): void {
    const o = this.org(orgId);
    const prev = o.reports.get(nodeId);
    o.reports.set(nodeId, { firstAt: prev?.firstAt ?? receivedAt, lastAt: receivedAt });
    const oldest = minuteOf(receivedAt) - (this.retainMinutes - 1) * MINUTE_MS;
    const from = Math.max(oldest, receivedAt - sample.intervalSec * 1000);
    const to = receivedAt;
    // Overlap (ms) of [from, to] with each minute it touches.
    const mins: number[] = [];
    const weights: number[] = [];
    for (let m = minuteOf(from); m <= minuteOf(to); m += MINUTE_MS) {
      const w = Math.min(to, m + MINUTE_MS) - Math.max(from, m);
      if (w <= 0 && !(from === to && m === minuteOf(to))) continue;
      mins.push(m);
      weights.push(Math.max(w, 1));
    }
    mins.forEach((m, i) => {
      const cov = o.coverage.get(m) ?? new Map<string, number>();
      cov.set(nodeId, Math.min(MINUTE_MS, (cov.get(nodeId) ?? 0) + weights[i]!));
      o.coverage.set(m, cov);
    });
    for (const h of sample.hosts) {
      const req = apportion(h.requests, weights);
      const err = apportion(h.errors5xx, weights);
      mins.forEach((m, i) => {
        if (req[i] === 0 && err[i] === 0) return;
        const cells = o.minutes.get(m) ?? new Map<string, HostCounter>();
        const key = `${nodeId}\u0000${h.host}`;
        const c = cells.get(key) ?? { requests: 0, errors5xx: 0 };
        c.requests += req[i]!;
        c.errors5xx += err[i]!;
        cells.set(key, c);
        o.minutes.set(m, cells);
      });
    }
    this.prune(receivedAt);
  }

  /** Drop minutes older than the ring (and edges not heard from in that long). */
  prune(now: number): void {
    const oldest = minuteOf(now) - (this.retainMinutes - 1) * MINUTE_MS;
    for (const o of this.orgs.values()) {
      for (const m of o.minutes.keys()) if (m < oldest) o.minutes.delete(m);
      for (const m of o.coverage.keys()) if (m < oldest) o.coverage.delete(m);
      for (const [n, r] of o.reports) if (r.lastAt < oldest) o.reports.delete(n);
    }
  }

  /** Cells with `from <= t < to`, oldest first. */
  cells(orgId: string, from: number, to: number): TrafficCell[] {
    const o = this.orgs.get(orgId);
    if (!o) return [];
    const out: TrafficCell[] = [];
    for (const m of [...o.minutes.keys()].sort((a, b) => a - b)) {
      if (m < from || m >= to) continue;
      for (const [key, c] of o.minutes.get(m)!) {
        const sep = key.indexOf('\u0000');
        out.push({ t: m, nodeId: key.slice(0, sep), host: key.slice(sep + 1), ...c });
      }
    }
    return out;
  }

  /** Minutes in `[from, to)` → edge → ms of the minute its reports covered. */
  coverage(orgId: string, from: number, to: number): Map<number, Map<string, number>> {
    const o = this.orgs.get(orgId);
    const out = new Map<number, Map<string, number>>();
    for (const [m, s] of o?.coverage ?? []) if (m >= from && m < to) out.set(m, new Map(s));
    return out;
  }

  reports(orgId: string): Map<string, EdgeReportSpan> {
    return new Map(this.orgs.get(orgId)?.reports ?? []);
  }
}

// ── rollups ────────────────────────────────────────────────────────────────

export interface TrafficRollupRow {
  bucketStart: number;
  nodeId: string;
  /** `''` = the per-edge coverage marker (the edge reported in this bucket). */
  host: string;
  requests: number;
  errors5xx: number;
}

/**
 * Fold the ring's minutes in `[from, to)` into `bucketMs` rows per (edge,
 * host). Every edge that reported in a bucket also gets a coverage row
 * (`host: ''`, zero counts) so a quiet bucket reads 0, not "no data".
 */
export function rollupRing(
  ring: EdgeTrafficRing,
  orgId: string,
  from: number,
  to: number,
  bucketMs = TRAFFIC_ROLLUP_MS,
): TrafficRollupRow[] {
  const acc = new Map<string, TrafficRollupRow>();
  const bucketOf = (t: number) => Math.floor(t / bucketMs) * bucketMs;
  for (const [m, nodes] of ring.coverage(orgId, from, to)) {
    for (const nodeId of nodes.keys()) {
      const b = bucketOf(m);
      const key = `${b}\u0000${nodeId}\u0000`;
      if (!acc.has(key)) acc.set(key, { bucketStart: b, nodeId, host: '', requests: 0, errors5xx: 0 });
    }
  }
  for (const c of ring.cells(orgId, from, to)) {
    const b = bucketOf(c.t);
    const key = `${b}\u0000${c.nodeId}\u0000${c.host}`;
    const row = acc.get(key) ?? { bucketStart: b, nodeId: c.nodeId, host: c.host, requests: 0, errors5xx: 0 };
    row.requests += c.requests;
    row.errors5xx += c.errors5xx;
    acc.set(key, row);
  }
  return [...acc.values()].sort(
    (a, b) => a.bucketStart - b.bucketStart || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : a.host < b.host ? -1 : a.host > b.host ? 1 : 0),
  );
}

/**
 * Which completed rollup buckets to flush: every bucket that started at or
 * after `watermark` and ended at least `graceMs` ago (late samples for the
 * bucket's last minute have landed). Returns `[from, to)` or undefined.
 */
export function rollupWindow(
  watermark: number,
  now: number,
  bucketMs = TRAFFIC_ROLLUP_MS,
  graceMs = 30_000,
): { from: number; to: number } | undefined {
  const to = Math.floor((now - graceMs) / bucketMs) * bucketMs;
  const from = Math.ceil(watermark / bucketMs) * bucketMs;
  return to > from ? { from, to } : undefined;
}

// ── read side: views ───────────────────────────────────────────────────────

export const TrafficWindow = z.enum(['6h', '24h', '7d']);
export type TrafficWindow = z.infer<typeof TrafficWindow>;

export const TrafficSeriesInput = z.object({
  /** An app (stack) name; `null` = the "other" bucket (hosts that are no app's route). */
  app: z.string().min(1).nullable().optional(),
  /** A region label (`swarmy.region`). */
  region: z.string().min(1).optional(),
  window: TrafficWindow.default('6h'),
});
export type TrafficSeriesInput = z.infer<typeof TrafficSeriesInput>;

/** Bucket width per window: 6 h → 5 min (72 points), 24 h → 15 min (96), 7 d → 1 h (168). */
export const TRAFFIC_WINDOWS: Record<TrafficWindow, { spanMs: number; bucketMs: number }> = {
  '6h': { spanMs: 6 * 60 * MINUTE_MS, bucketMs: 5 * MINUTE_MS },
  '24h': { spanMs: 24 * 60 * MINUTE_MS, bucketMs: 15 * MINUTE_MS },
  '7d': { spanMs: 7 * 24 * 60 * MINUTE_MS, bucketMs: 60 * MINUTE_MS },
};

/** `reporting` = heard from recently; `stale` = was, not lately; `no-data` = nothing yet. */
export type EdgeTrafficState = 'reporting' | 'stale' | 'no-data';

export interface TrafficEdgeView {
  nodeId: string;
  name: string;
  region: string | null;
  state: EdgeTrafficState;
  /** Requests a minute over the window, or null with no complete minute of data. */
  requestsPerMin: number | null;
  lastReportAt: number | null;
}

export interface TrafficRegionView {
  /** `swarmy.region` label; null = edges with no region label. */
  region: string | null;
  /** Sum over its reporting edges; null when none has data yet. */
  requestsPerMin: number | null;
  errors5xxPerMin: number | null;
  state: 'reporting' | 'no-data';
  edges: TrafficEdgeView[];
}

export interface TrafficAppView {
  /** App (stack) name; null = "other" — hosts that are no app's route. Never dropped. */
  app: string | null;
  requestsPerMin: number;
  errors5xxPerMin: number;
  /** errors5xx / requests (0..1); null with no requests. */
  errorShare: number | null;
  hosts: string[];
}

export interface TrafficNowView {
  /** Latest edge report (ms), null when no edge has reported. */
  sampledAt: number | null;
  windowMinutes: number;
  unit: 'requests/min';
  totals: {
    requestsPerMin: number | null;
    errors5xxPerMin: number | null;
    errorShare: number | null;
    state: 'reporting' | 'no-data';
  };
  regions: TrafficRegionView[];
  apps: TrafficAppView[];
}

export interface TrafficSeriesPoint {
  /** Bucket start (ms). */
  t: number;
  /** null = no edge reported in this bucket (a gap, not a zero). */
  requestsPerMin: number | null;
  errors5xxPerMin: number | null;
}

export interface TrafficSeriesView {
  window: TrafficWindow;
  bucketSec: number;
  unit: 'requests/min';
  app?: string | null;
  region?: string;
  sampledAt: number | null;
  points: TrafficSeriesPoint[];
}

export interface TrafficEdgeInfo {
  nodeId: string;
  name: string;
  region: string | null;
}

/** Resolve a host to its app: exact route host, then a `*.parent` wildcard route. */
export function makeHostAppResolver(routes: ReadonlyArray<{ host: string; app: string; path?: string }>): (host: string) => string | null {
  const byHost = new Map<string, { app: string; path: string }>();
  for (const r of routes) {
    const h = normalizeTrafficHost(r.host);
    const path = r.path ?? '/';
    const cur = byHost.get(h);
    // Several apps on one host (path routing): the root route's owner wins,
    // else the shortest path, else the alphabetically first app.
    if (!cur || path.length < cur.path.length || (path.length === cur.path.length && r.app < cur.app)) {
      byHost.set(h, { app: r.app, path });
    }
  }
  return (host: string) => {
    const h = normalizeTrafficHost(host);
    const exact = byHost.get(h);
    if (exact) return exact.app;
    const dot = h.indexOf('.');
    if (dot > 0) {
      const wild = byHost.get(`*${h.slice(dot)}`);
      if (wild) return wild.app;
    }
    return null;
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * "Right now": per region and per app over the last `windowMinutes` COMPLETE
 * minutes. Each edge's rate divides by the minutes it actually reported in
 * that window, so an edge that came up two minutes ago is not diluted.
 */
export function aggregateTrafficNow(args: {
  cells: readonly TrafficCell[];
  coverage: Map<number, Map<string, number>>;
  reports: Map<string, EdgeReportSpan>;
  edges: readonly TrafficEdgeInfo[];
  appOf: (host: string) => string | null;
  now: number;
  windowMinutes?: number;
}): TrafficNowView {
  const windowMinutes = args.windowMinutes ?? TRAFFIC_NOW_WINDOW_MINUTES;
  const end = minuteOf(args.now);
  const start = end - windowMinutes * MINUTE_MS;
  // Every edge we know about: the listed edges plus any that reported (never drop one).
  const edges = new Map(args.edges.map((e) => [e.nodeId, e] as const));
  for (const nodeId of args.reports.keys()) {
    if (!edges.has(nodeId)) edges.set(nodeId, { nodeId, name: nodeId, region: null });
  }
  // Minutes (fractional) of the window each edge's reports covered.
  const covered = new Map<string, number>();
  for (const [m, nodes] of args.coverage) {
    if (m < start || m >= end) continue;
    for (const [n, ms] of nodes) covered.set(n, (covered.get(n) ?? 0) + ms / MINUTE_MS);
  }
  const perEdge = new Map<string, HostCounter>();
  const perApp = new Map<string | null, { requests: number; errors5xx: number; hosts: Set<string> }>();
  for (const c of args.cells) {
    if (c.t < start || c.t >= end) continue;
    const mins = covered.get(c.nodeId);
    if (!mins) continue;
    const e = perEdge.get(c.nodeId) ?? { requests: 0, errors5xx: 0 };
    e.requests += c.requests;
    e.errors5xx += c.errors5xx;
    perEdge.set(c.nodeId, e);
    const app = args.appOf(c.host);
    const a = perApp.get(app) ?? { requests: 0, errors5xx: 0, hosts: new Set<string>() };
    a.requests += c.requests / mins;
    a.errors5xx += c.errors5xx / mins;
    a.hosts.add(c.host);
    perApp.set(app, a);
  }

  const regions = new Map<string | null, TrafficRegionView>();
  const regionRaw = new Map<string | null, HostCounter>();
  let sampledAt: number | null = null;
  for (const e of [...edges.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const rep = args.reports.get(e.nodeId);
    if (rep) sampledAt = Math.max(sampledAt ?? 0, rep.lastAt);
    const mins = covered.get(e.nodeId) ?? 0;
    const counts = perEdge.get(e.nodeId) ?? { requests: 0, errors5xx: 0 };
    const state: EdgeTrafficState = !rep ? 'no-data' : args.now - rep.lastAt > TRAFFIC_STALE_MS ? 'stale' : mins > 0 ? 'reporting' : 'no-data';
    const view: TrafficEdgeView = {
      nodeId: e.nodeId,
      name: e.name,
      region: e.region,
      state,
      requestsPerMin: mins > 0 ? round1(counts.requests / mins) : null,
      lastReportAt: rep?.lastAt ?? null,
    };
    const r = regions.get(e.region) ?? {
      region: e.region,
      requestsPerMin: null,
      errors5xxPerMin: null,
      state: 'no-data' as const,
      edges: [],
    };
    r.edges.push(view);
    if (mins > 0) {
      const raw = regionRaw.get(e.region) ?? { requests: 0, errors5xx: 0 };
      raw.requests += counts.requests / mins;
      raw.errors5xx += counts.errors5xx / mins;
      regionRaw.set(e.region, raw);
      r.requestsPerMin = round1(raw.requests);
      r.errors5xxPerMin = round1(raw.errors5xx);
      r.state = 'reporting';
    }
    regions.set(e.region, r);
  }

  const regionList = [...regions.values()].sort(
    (a, b) => (b.requestsPerMin ?? -1) - (a.requestsPerMin ?? -1) || String(a.region).localeCompare(String(b.region)),
  );
  const reporting = regionList.filter((r) => r.requestsPerMin !== null);
  const raws = [...regionRaw.values()];
  const totalReq = reporting.length ? round1(raws.reduce((n, r) => n + r.requests, 0)) : null;
  const totalErr = reporting.length ? round1(raws.reduce((n, r) => n + r.errors5xx, 0)) : null;

  const apps: TrafficAppView[] = [...perApp.entries()]
    .map(([app, a]) => ({
      app,
      requestsPerMin: round1(a.requests),
      errors5xxPerMin: round1(a.errors5xx),
      errorShare: a.requests > 0 ? Math.round((a.errors5xx / a.requests) * 10_000) / 10_000 : null,
      hosts: [...a.hosts].sort(),
    }))
    // "other" last; otherwise busiest first.
    .sort((x, y) => (x.app === null ? 1 : 0) - (y.app === null ? 1 : 0) || y.requestsPerMin - x.requestsPerMin || String(x.app).localeCompare(String(y.app)));

  return {
    sampledAt,
    windowMinutes,
    unit: 'requests/min',
    totals: {
      requestsPerMin: totalReq,
      errors5xxPerMin: totalErr,
      errorShare: totalReq !== null && totalReq > 0 && totalErr !== null ? Math.round((totalErr / totalReq) * 10_000) / 10_000 : null,
      state: totalReq === null ? 'no-data' : 'reporting',
    },
    regions: regionList,
    apps,
  };
}

/** A pre-filtered row for series bucketing (from the ring or the rollup table). */
export interface TrafficSeriesRow {
  t: number;
  nodeId: string;
  /** `''` = coverage marker. */
  host: string;
  requests: number;
  errors5xx: number;
}

/**
 * Bucket rows into the complete `bucketMs` buckets of the last `span`. A bucket nobody
 * reported in is `null` (a gap); one with coverage but no requests is 0.
 */
export function bucketTrafficSeries(args: {
  rows: readonly TrafficSeriesRow[];
  /** Bucket starts (any alignment finer than bucketMs) in which an edge reported. */
  coveredAt: Iterable<number>;
  window: TrafficWindow;
  now: number;
}): { bucketSec: number; points: TrafficSeriesPoint[] } {
  const { spanMs, bucketMs } = TRAFFIC_WINDOWS[args.window];
  // Complete buckets only: a half-filled newest bucket would read as a dip.
  const end = Math.floor(args.now / bucketMs) * bucketMs;
  const start = end - spanMs;
  const n = spanMs / bucketMs;
  const req = new Array<number>(n).fill(0);
  const err = new Array<number>(n).fill(0);
  const cov = new Array<boolean>(n).fill(false);
  const idx = (t: number) => Math.floor((t - start) / bucketMs);
  for (const t of args.coveredAt) {
    const i = idx(t);
    if (i >= 0 && i < n) cov[i] = true;
  }
  for (const r of args.rows) {
    const i = idx(r.t);
    if (i < 0 || i >= n) continue;
    cov[i] = true;
    req[i]! += r.requests;
    err[i]! += r.errors5xx;
  }
  const perMin = bucketMs / MINUTE_MS;
  return {
    bucketSec: bucketMs / 1000,
    points: req.map((r, i) => ({
      t: start + i * bucketMs,
      requestsPerMin: cov[i] ? round1(r / perMin) : null,
      errors5xxPerMin: cov[i] ? round1(err[i]! / perMin) : null,
    })),
  };
}
