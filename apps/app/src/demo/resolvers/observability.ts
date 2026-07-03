import type { DemoStore, DomainResolvers } from '../types';

/**
 * Demo resolvers for the Observability / Mission Control surface (router
 * `observability`).
 *
 * With no backend there is no OTel collector or ClickHouse store, so we keep an
 * always-on, believable telemetry world in `store.extra['observability']` and
 * project it into the exact view shapes the dashboard reads (see
 * packages/trpc/src/services/observability.service.ts → ObservabilityStatusView,
 * TracesResult, TraceDetailResult, MetricsResult, MetricsSummaryResult and
 * packages/trpc/src/services/observability-query.ts → TraceRow, SpanRow,
 * MetricsPoint, MetricsSummaryRow).
 *
 * The suite starts ON (telemetry flowing) so every panel looks alive on first
 * load; the master toggle (`setEnabled`) flips the stored flag + collector/store
 * state, and the UI invalidates queries on success so it reflects immediately.
 * Traces are seeded with deterministic span trees keyed by trace_id so the
 * `/observability/$traceId` waterfall resolves a real tree for any listed trace.
 */

// ── View shapes (mirror observability.service.ts / observability-query.ts) ────

type CollectorStatus = 'OFFLINE' | 'DEPLOYING' | 'RUNNING' | 'FAILED';

interface ObservabilityStatusView {
  enabled: boolean;
  collectorStatus: CollectorStatus;
  retentionDays: number;
  storeConfigured: boolean;
  storeEndpoint: string | null;
  updatedAt: string | null;
  storeReachable: boolean;
  stacksEnabled: number;
}

interface TraceRow {
  trace_id: string;
  span_id: string;
  service_name: string;
  span_name: string;
  duration_ms: number;
  status_code: string;
  span_count: number;
  start_time: string;
}

interface SpanRow {
  trace_id: string;
  span_id: string;
  parent_span_id: string;
  service_name: string;
  span_name: string;
  span_kind: string;
  start_unix_nano: string;
  duration_ms: number;
  status_code: string;
  status_message: string;
}

interface MetricsPoint {
  bucket: string;
  value: number;
}

interface MetricsSummaryRow {
  service_name: string;
  avg_value: number;
  max_value: number;
  samples: number;
}

type ReadStatus = 'ok' | 'disabled' | 'unreachable';

interface TracesResult {
  status: ReadStatus;
  traces: TraceRow[];
}

interface MetricsResult {
  status: ReadStatus;
  points: MetricsPoint[];
}

interface TraceDetailResult {
  status: ReadStatus | 'not_found';
  spans: SpanRow[];
}

interface MetricsSummaryResult {
  status: ReadStatus;
  rows: MetricsSummaryRow[];
}

const STATUS_OK = 'STATUS_CODE_OK';
const STATUS_ERROR = 'STATUS_CODE_ERROR';
const STORE_ENDPOINT = 'clickhouse:8123';

/** Metric names surfaced by the dashboard's metric picker (METRIC_PRESETS). */
const METRICS = ['http.server.duration', 'system.cpu.utilization', 'system.memory.usage'] as const;

/** Telemetry-emitting services in the demo cluster, by name (svc-* ids upstream). */
const TELEMETRY_SERVICES = ['web', 'api', 'checkout', 'cdn-edge', 'worker'] as const;

/** Demo stack → telemetry services (mirrors DEMO_STACKS / DEMO_SERVICES seeding). */
const STACK_SERVICES: Record<string, readonly string[]> = {
  storefront: ['web', 'api', 'checkout', 'cdn-edge'],
  data: ['worker'],
};

/** The telemetry services in scope: one stack's, or the whole estate's. */
function servicesFor(stack?: string): readonly string[] {
  return stack ? (STACK_SERVICES[stack] ?? []) : TELEMETRY_SERVICES;
}

/** Predicate for stack-scoped row filters over `service_name` columns. */
function inStack(stack: string | undefined, serviceName: string): boolean {
  return !stack || servicesFor(stack).includes(serviceName);
}

/** Everything the observability surface owns in the demo store. */
interface ObservabilityState {
  config: {
    enabled: boolean;
    collectorStatus: CollectorStatus;
    retentionDays: number;
    storeConfigured: boolean;
    storeEndpoint: string | null;
    updatedAt: string;
    storeReachable: boolean;
    stacksEnabled: number;
  };
  /** Trace-list rows (root spans), newest first. */
  traces: TraceRow[];
  /** Full span tree per trace_id, for the waterfall view. */
  spans: Record<string, SpanRow[]>;
  /**
   * Stack names opted into telemetry — the demo stand-in for the
   * `swarmy.otel.enabled` service label the live controller stamps. The per-stack
   * toggle reads/flips this; `config.stacksEnabled` tracks its size.
   */
  telemetryStacks: string[];
}

const now = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const isoAgo = (msAgo: number): string => new Date(now - msAgo).toISOString();

/** Deterministic-ish hex id of the given length. */
function hex(len: number): string {
  let out = '';
  while (out.length < len) out += Math.random().toString(16).slice(2);
  return out.slice(0, len);
}

const traceId = (): string => hex(32);
const spanId = (): string => hex(16);

/** Read (or lazily init) the observability slice of the store. */
function state(store: DemoStore): ObservabilityState {
  const existing = store.extra['observability'] as ObservabilityState | undefined;
  if (existing) return existing;
  const fresh = buildSeed();
  store.extra['observability'] = fresh;
  return fresh;
}

// ── Trace seeding ────────────────────────────────────────────────────────────

/**
 * A small library of realistic root operations per service. Each entry defines
 * the root span name, kind, and a child-span chain so the waterfall has depth.
 */
interface OpTemplate {
  service: string;
  rootName: string;
  rootKind: string;
  baseMs: number;
  children: Array<{ service: string; name: string; kind: string; share: number }>;
}

const OP_TEMPLATES: OpTemplate[] = [
  {
    service: 'web',
    rootName: 'GET /checkout',
    rootKind: 'SPAN_KIND_SERVER',
    baseMs: 184,
    children: [
      { service: 'web', name: 'render page', kind: 'SPAN_KIND_INTERNAL', share: 0.18 },
      { service: 'api', name: 'GET /api/cart', kind: 'SPAN_KIND_CLIENT', share: 0.46 },
      { service: 'api', name: 'SELECT carts', kind: 'SPAN_KIND_CLIENT', share: 0.22 },
    ],
  },
  {
    service: 'api',
    rootName: 'POST /api/orders',
    rootKind: 'SPAN_KIND_SERVER',
    baseMs: 312,
    children: [
      { service: 'api', name: 'validate order', kind: 'SPAN_KIND_INTERNAL', share: 0.12 },
      { service: 'checkout', name: 'charge payment', kind: 'SPAN_KIND_CLIENT', share: 0.51 },
      { service: 'worker', name: 'publish order.created', kind: 'SPAN_KIND_PRODUCER', share: 0.14 },
      { service: 'api', name: 'INSERT orders', kind: 'SPAN_KIND_CLIENT', share: 0.18 },
    ],
  },
  {
    service: 'api',
    rootName: 'GET /api/products',
    rootKind: 'SPAN_KIND_SERVER',
    baseMs: 96,
    children: [
      { service: 'api', name: 'GET redis:catalog', kind: 'SPAN_KIND_CLIENT', share: 0.28 },
      { service: 'api', name: 'SELECT products', kind: 'SPAN_KIND_CLIENT', share: 0.4 },
    ],
  },
  {
    service: 'checkout',
    rootName: 'POST /charge',
    rootKind: 'SPAN_KIND_SERVER',
    baseMs: 421,
    children: [
      { service: 'checkout', name: 'tokenize card', kind: 'SPAN_KIND_INTERNAL', share: 0.16 },
      { service: 'checkout', name: 'POST stripe.com/charges', kind: 'SPAN_KIND_CLIENT', share: 0.62 },
    ],
  },
  {
    service: 'cdn-edge',
    rootName: 'GET /assets/app.js',
    rootKind: 'SPAN_KIND_SERVER',
    baseMs: 22,
    children: [{ service: 'cdn-edge', name: 'cache lookup', kind: 'SPAN_KIND_INTERNAL', share: 0.4 }],
  },
  {
    service: 'worker',
    rootName: 'process order.created',
    rootKind: 'SPAN_KIND_CONSUMER',
    baseMs: 268,
    children: [
      { service: 'worker', name: 'reserve inventory', kind: 'SPAN_KIND_CLIENT', share: 0.34 },
      { service: 'worker', name: 'send confirmation email', kind: 'SPAN_KIND_CLIENT', share: 0.5 },
    ],
  },
];

/** Build a root TraceRow + its span tree from a template at a given age/jitter. */
function makeTrace(tpl: OpTemplate, ageMs: number, isError: boolean): {
  row: TraceRow;
  spans: SpanRow[];
} {
  const tId = traceId();
  const rootSpanId = spanId();
  const jitter = 0.7 + Math.random() * 0.8;
  const rootDuration = Math.round(tpl.baseMs * jitter * 100) / 100;
  const rootStartNano = (now - ageMs) * 1_000_000;

  const spans: SpanRow[] = [];
  spans.push({
    trace_id: tId,
    span_id: rootSpanId,
    parent_span_id: '',
    service_name: tpl.service,
    span_name: tpl.rootName,
    span_kind: tpl.rootKind,
    start_unix_nano: String(Math.round(rootStartNano)),
    duration_ms: rootDuration,
    status_code: isError ? STATUS_ERROR : STATUS_OK,
    status_message: isError ? 'upstream timeout' : '',
  });

  // Lay children sequentially within the root window so offsets stagger nicely.
  let cursorMs = rootDuration * 0.05;
  // An error trace fails on its last child; others succeed.
  const childErrorIdx = isError ? tpl.children.length - 1 : -1;
  tpl.children.forEach((child, idx) => {
    const childDuration = Math.round(rootDuration * child.share * 100) / 100;
    const childStartNano = rootStartNano + cursorMs * 1_000_000;
    spans.push({
      trace_id: tId,
      span_id: spanId(),
      parent_span_id: rootSpanId,
      service_name: child.service,
      span_name: child.name,
      span_kind: child.kind,
      start_unix_nano: String(Math.round(childStartNano)),
      duration_ms: childDuration,
      status_code: idx === childErrorIdx ? STATUS_ERROR : STATUS_OK,
      status_message: idx === childErrorIdx ? 'connection reset' : '',
    });
    cursorMs += childDuration * 0.7;
  });

  const row: TraceRow = {
    trace_id: tId,
    span_id: rootSpanId,
    service_name: tpl.service,
    span_name: tpl.rootName,
    duration_ms: rootDuration,
    status_code: isError ? STATUS_ERROR : STATUS_OK,
    span_count: spans.length,
    start_time: new Date(now - ageMs).toISOString().replace('T', ' ').replace('Z', ''),
  };

  return { row, spans };
}

/** Seed ~24 traces across the last hour, ~15% errors, newest first. */
function seedTraces(): { traces: TraceRow[]; spans: Record<string, SpanRow[]> } {
  const traces: TraceRow[] = [];
  const spans: Record<string, SpanRow[]> = {};
  const count = 24;
  for (let i = 0; i < count; i++) {
    const tpl = OP_TEMPLATES[i % OP_TEMPLATES.length]!;
    // Spread ages from ~30s ago back to ~58 minutes ago.
    const ageMs = 30_000 + Math.round((i / count) * (58 * MIN)) + Math.round(Math.random() * 20_000);
    const isError = Math.random() < 0.15;
    const { row, spans: tspans } = makeTrace(tpl, ageMs, isError);
    traces.push(row);
    spans[row.trace_id] = tspans;
  }
  // Newest first (smallest age = most recent). Ages grow with i, so reverse.
  traces.reverse();
  return { traces, spans };
}

function buildSeed(): ObservabilityState {
  const { traces, spans } = seedTraces();
  return {
    config: {
      enabled: true,
      collectorStatus: 'RUNNING',
      retentionDays: 7,
      storeConfigured: true,
      storeEndpoint: STORE_ENDPOINT,
      updatedAt: isoAgo(2 * HOUR),
      storeReachable: true,
      stacksEnabled: 2,
    },
    traces,
    spans,
    telemetryStacks: ['storefront', 'data'],
  };
}

// ── Metrics generation ───────────────────────────────────────────────────────

/** Plausible baseline (avg) per metric per service, for summary + series. */
function metricBaseline(metric: string, service: string): number {
  if (metric === 'http.server.duration') {
    const byService: Record<string, number> = {
      web: 142,
      api: 211,
      checkout: 388,
      'cdn-edge': 18,
      worker: 264,
    };
    return byService[service] ?? 120;
  }
  if (metric === 'system.cpu.utilization') {
    const byService: Record<string, number> = {
      web: 0.34,
      api: 0.58,
      checkout: 0.41,
      'cdn-edge': 0.12,
      worker: 0.66,
    };
    return byService[service] ?? 0.3;
  }
  // system.memory.usage — bytes.
  const byService: Record<string, number> = {
    web: 268 * 1024 * 1024,
    api: 512 * 1024 * 1024,
    checkout: 196 * 1024 * 1024,
    'cdn-edge': 96 * 1024 * 1024,
    worker: 624 * 1024 * 1024,
  };
  return byService[service] ?? 256 * 1024 * 1024;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Per-minute series for the last `windowMinutes`, averaged across the scope. */
function buildSeries(
  metric: string,
  windowMinutes: number,
  bucketSeconds: number,
  service?: string,
  stack?: string,
): MetricsPoint[] {
  const services = service ? [service] : [...servicesFor(stack)];
  if (services.length === 0) return [];
  const base = services.reduce((sum, s) => sum + metricBaseline(metric, s), 0) / services.length;
  const buckets = Math.max(1, Math.min(360, Math.floor((windowMinutes * 60) / bucketSeconds)));
  const points: MetricsPoint[] = [];
  for (let i = buckets - 1; i >= 0; i--) {
    const ts = now - i * bucketSeconds * 1000;
    // Gentle sinusoidal load curve + noise so the bars look organic.
    const wave = 1 + 0.35 * Math.sin(i / 4) + (Math.random() - 0.5) * 0.18;
    points.push({
      bucket: new Date(ts).toISOString().replace('T', ' ').replace('Z', ''),
      value: round4(base * Math.max(0.2, wave)),
    });
  }
  return points;
}

/** Per-service aggregate (avg/peak/samples) of a metric over the window. */
function buildSummary(metric: string, windowMinutes: number, limit: number, stack?: string): MetricsSummaryRow[] {
  const services = servicesFor(stack);
  const samplesPerMin = 60; // a sample per second
  const rows: MetricsSummaryRow[] = services.map((service) => {
    const avg = metricBaseline(metric, service);
    return {
      service_name: service,
      avg_value: round4(avg),
      max_value: round4(avg * (1.4 + Math.random() * 0.4)),
      samples: windowMinutes * samplesPerMin,
    };
  });
  rows.sort((a, b) => b.avg_value - a.avg_value);
  return rows.slice(0, limit);
}

function toStatusView(st: ObservabilityState): ObservabilityStatusView {
  const c = st.config;
  return {
    enabled: c.enabled,
    collectorStatus: c.collectorStatus,
    retentionDays: c.retentionDays,
    storeConfigured: c.storeConfigured,
    storeEndpoint: c.storeEndpoint,
    updatedAt: c.updatedAt,
    storeReachable: c.enabled ? c.storeReachable : false,
    stacksEnabled: c.stacksEnabled,
  };
}

// ── Resolvers ────────────────────────────────────────────────────────────────

export const observability: DomainResolvers = {
  seed: (store) => {
    store.extra['observability'] = buildSeed();
  },

  handlers: {
    'observability.status': (_i, s): ObservabilityStatusView => toStatusView(state(s)),

    'observability.setEnabled': (i, s): ObservabilityStatusView => {
      const { enabled } = i as { enabled: boolean };
      const st = state(s);
      st.config.enabled = enabled;
      st.config.collectorStatus = enabled ? 'RUNNING' : 'OFFLINE';
      st.config.storeReachable = enabled;
      st.config.updatedAt = new Date().toISOString();
      return toStatusView(st);
    },

    // Per-stack opt-in — the demo stand-in for the `swarmy.otel.enabled` label.
    'observability.stackTelemetry': (i, s): { enabled: boolean } => {
      const { stack } = i as { stack: string };
      return { enabled: state(s).telemetryStacks.includes(stack) };
    },

    'observability.enableForStack': (i, s): { id: string; enabled: boolean } => {
      const { stackId, enabled } = i as { stackId: string; enabled: boolean };
      const st = state(s);
      // The toggle passes the stack name; label-only stacks surface name as id.
      const name = s.stacks.find((x) => x.id === stackId)?.name ?? stackId;
      const set = new Set(st.telemetryStacks);
      if (enabled) set.add(name);
      else set.delete(name);
      st.telemetryStacks = [...set];
      st.config.stacksEnabled = st.telemetryStacks.length;
      return { id: stackId, enabled };
    },

    'observability.traces': (i, s): TracesResult => {
      const q =
        (i as {
          service?: string;
          stack?: string;
          minDurationMs?: number;
          errorsOnly?: boolean;
          windowMinutes?: number;
          limit?: number;
        }) ?? {};
      const st = state(s);
      if (!st.config.enabled) return { status: 'disabled', traces: [] };
      let rows = st.traces;
      if (q.stack) rows = rows.filter((t) => inStack(q.stack, t.service_name));
      if (q.service) rows = rows.filter((t) => t.service_name === q.service);
      if (q.errorsOnly) rows = rows.filter((t) => t.status_code !== STATUS_OK);
      if (q.minDurationMs && q.minDurationMs > 0) {
        rows = rows.filter((t) => t.duration_ms >= (q.minDurationMs as number));
      }
      const limit = q.limit ?? 100;
      return { status: 'ok', traces: rows.slice(0, limit) };
    },

    'observability.traceDetail': (i, s): TraceDetailResult => {
      const { traceId: tId } = i as { traceId: string };
      const st = state(s);
      if (!st.config.enabled) return { status: 'disabled', spans: [] };
      const spans = st.spans[tId];
      if (!spans || spans.length === 0) return { status: 'not_found', spans: [] };
      return { status: 'ok', spans };
    },

    'observability.metricsSummary': (i, s): MetricsSummaryResult => {
      const q =
        (i as { metric: string; stack?: string; windowMinutes?: number; limit?: number }) ?? { metric: METRICS[0] };
      const st = state(s);
      if (!st.config.enabled) return { status: 'disabled', rows: [] };
      const rows = buildSummary(q.metric, q.windowMinutes ?? 60, q.limit ?? 50, q.stack);
      return { status: 'ok', rows };
    },

    'observability.metricsSeries': (i, s): MetricsResult => {
      const q =
        (i as { metric: string; service?: string; stack?: string; windowMinutes?: number; bucketSeconds?: number }) ?? {
          metric: METRICS[0],
        };
      const st = state(s);
      if (!st.config.enabled) return { status: 'disabled', points: [] };
      const points = buildSeries(q.metric, q.windowMinutes ?? 60, q.bucketSeconds ?? 60, q.service, q.stack);
      return { status: 'ok', points };
    },
  },
};

// ── logs (C1) ─────────────────────────────────────────────────────────────────
// Appended by the logs slice: ~200 plausible otel_logs rows over the last 24h
// across the telemetry services, ~2 lines correlated to every seeded trace so
// "View trace" always resolves a waterfall. Shapes come from @swarmy/core
// (LogRowView / ObservabilityLogsPage) — the same types the real service returns.

import type { LogRowView, ObservabilityLogsPage } from '@swarmy/core';

interface LogTemplate {
  body: string;
  severity: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';
  attrs?: Record<string, string>;
}

const SEVERITY_NUMBER: Record<LogTemplate['severity'], number> = {
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
  FATAL: 21,
};

/** Weighted, service-flavoured line library — mostly info, some noise, few fires. */
const LOG_TEMPLATES: Record<string, LogTemplate[]> = {
  web: [
    { body: 'GET / 200 in 12ms', severity: 'INFO', attrs: { 'http.method': 'GET', 'http.status_code': '200' } },
    { body: 'GET /checkout 200 in 184ms', severity: 'INFO', attrs: { 'http.method': 'GET', 'http.status_code': '200' } },
    { body: 'session refreshed for user u_48213', severity: 'DEBUG', attrs: { 'user.id': 'u_48213' } },
    { body: 'slow render: /checkout took 812ms (budget 300ms)', severity: 'WARN', attrs: { 'http.route': '/checkout' } },
    { body: 'unhandled rejection: fetch to api failed (ECONNRESET)', severity: 'ERROR', attrs: { 'peer.service': 'api' } },
  ],
  api: [
    { body: 'POST /api/orders 201 (order_9f3k2)', severity: 'INFO', attrs: { 'http.method': 'POST', 'order.id': 'order_9f3k2' } },
    { body: 'GET /api/cart 200 in 46ms', severity: 'INFO', attrs: { 'http.method': 'GET', 'http.status_code': '200' } },
    { body: 'SELECT carts WHERE user_id = $1 — 12 rows in 8ms', severity: 'DEBUG', attrs: { 'db.system': 'postgresql' } },
    { body: 'rate limit at 82% for key live_k1', severity: 'WARN', attrs: { 'ratelimit.remaining': '54' } },
    { body: 'upstream timeout talking to checkout after 5000ms', severity: 'ERROR', attrs: { 'peer.service': 'checkout' } },
    { body: 'pg: connection reset — retrying (1/3)', severity: 'WARN', attrs: { 'db.system': 'postgresql' } },
  ],
  checkout: [
    { body: 'charge authorized: $184.20 (visa ••4242)', severity: 'INFO', attrs: { 'payment.provider': 'stripe' } },
    { body: 'card tokenized ok in 96ms', severity: 'DEBUG', attrs: { 'payment.provider': 'stripe' } },
    { body: 'stripe latency 1.9s — above 1s SLO', severity: 'WARN', attrs: { 'peer.service': 'stripe.com' } },
    { body: 'charge declined: insufficient_funds (order_2b81x)', severity: 'ERROR', attrs: { 'order.id': 'order_2b81x' } },
    { body: 'payment worker crashed: OOMKilled — restarting', severity: 'FATAL', attrs: { 'container.exit_code': '137' } },
  ],
  'cdn-edge': [
    { body: 'cache HIT /assets/app.js (11ms)', severity: 'INFO', attrs: { 'cache.result': 'hit' } },
    { body: 'cache MISS /assets/logo.svg — origin fetch 44ms', severity: 'INFO', attrs: { 'cache.result': 'miss' } },
    { body: 'purged 214 stale objects', severity: 'DEBUG' },
    { body: 'origin fetch slow: 1.2s for /assets/hero.webp', severity: 'WARN', attrs: { 'cache.result': 'miss' } },
  ],
  worker: [
    { body: 'processed order.created in 264ms', severity: 'INFO', attrs: { 'messaging.destination': 'order.created' } },
    { body: 'email queued: order confirmation (order_9f3k2)', severity: 'INFO', attrs: { 'order.id': 'order_9f3k2' } },
    { body: 'reserved inventory: 3 items for order_9f3k2', severity: 'DEBUG', attrs: { 'order.id': 'order_9f3k2' } },
    { body: 'queue depth 143 on order.created — scale rule will add a worker', severity: 'WARN', attrs: { 'queue.depth': '143' } },
    { body: 'email provider returned 502 — retry 2/5 in 30s', severity: 'ERROR', attrs: { 'peer.service': 'postmark' } },
  ],
};

/** Weighted template pick: mostly the info/debug lines, occasionally the fires. */
function pickTemplate(service: string): LogTemplate {
  const pool = LOG_TEMPLATES[service] ?? LOG_TEMPLATES['api']!;
  // ~72% first two (info), ~13% third, ~10% fourth, ~5% the rest.
  const r = Math.random();
  const idx =
    r < 0.4 ? 0 : r < 0.72 ? 1 : r < 0.85 ? Math.min(2, pool.length - 1) : r < 0.95 ? Math.min(3, pool.length - 1) : pool.length - 1;
  return pool[Math.min(idx, pool.length - 1)]!;
}

function makeLogRow(service: string, atMs: number, tpl: LogTemplate, tid: string, sid: string): LogRowView {
  return {
    timestamp: new Date(atMs).toISOString().replace('T', ' ').replace('Z', ''),
    ts_nano: `${Math.floor(atMs)}000000`,
    trace_id: tid,
    span_id: sid,
    severity_text: tpl.severity,
    severity_number: SEVERITY_NUMBER[tpl.severity],
    service_name: service,
    body: tpl.body,
    attributes: tpl.attrs ?? {},
  };
}

/** Seed ~200 rows: ~2 per seeded trace (correlated) + background noise over 24h. */
function buildLogSeed(st: ObservabilityState): LogRowView[] {
  const rows: LogRowView[] = [];

  // Correlated lines: reuse each seeded trace's id + spans so links resolve.
  for (const trace of st.traces) {
    const spans = st.spans[trace.trace_id] ?? [];
    for (const span of spans.slice(0, 2)) {
      const atMs = Number(span.start_unix_nano) / 1_000_000 + Math.random() * 5;
      const isError = span.status_code !== STATUS_OK;
      const tpl: LogTemplate = isError
        ? { body: `${span.span_name} failed: ${span.status_message || 'error'}`, severity: 'ERROR' }
        : { body: `${span.span_name} completed in ${span.duration_ms}ms`, severity: 'INFO' };
      rows.push(makeLogRow(span.service_name, atMs, tpl, trace.trace_id, span.span_id));
    }
  }

  // Background noise: ~160 uncorrelated lines, denser in the last hour.
  const services = [...TELEMETRY_SERVICES];
  for (let i = 0; i < 160; i++) {
    const service = services[i % services.length]!;
    // 60% inside the last hour, the rest spread across 24h.
    const ageMs =
      Math.random() < 0.6
        ? Math.random() * HOUR
        : HOUR + Math.random() * 23 * HOUR;
    const atMs = now - ageMs;
    rows.push(makeLogRow(service, atMs, pickTemplate(service), '', hex(16)));
  }

  rows.sort((a, b) => Number(b.ts_nano) - Number(a.ts_nano));
  return rows;
}

/** Lazily seeded log rows (own extra key so the C1 append stays self-contained). */
function logRows(store: DemoStore): LogRowView[] {
  const key = 'observability.logs';
  const existing = store.extra[key] as LogRowView[] | undefined;
  if (existing) return existing;
  const fresh = buildLogSeed(state(store));
  store.extra[key] = fresh;
  return fresh;
}

observability.handlers!['observability.logs'] = (i, s): ObservabilityLogsPage => {
  const q =
    (i as {
      from: number;
      to: number;
      stack?: string;
      serviceName?: string;
      severityMin?: number;
      search?: string;
      traceId?: string;
      limit?: number;
      cursor?: string;
    }) ?? { from: 0, to: Date.now() };
  const st = state(s);
  if (!st.config.enabled) return { status: 'disabled', rows: [], nextCursor: null };

  const fromNano = Math.max(0, Math.floor(q.from)) * 1_000_000;
  const toNano = Math.max(0, Math.floor(q.to)) * 1_000_000;
  let rows = logRows(s).filter((r) => {
    const ts = Number(r.ts_nano);
    return ts >= fromNano && ts <= toNano;
  });
  if (q.stack) rows = rows.filter((r) => inStack(q.stack, r.service_name));
  if (q.serviceName) rows = rows.filter((r) => r.service_name === q.serviceName);
  if (q.severityMin !== undefined) rows = rows.filter((r) => r.severity_number >= (q.severityMin as number));
  if (q.search) {
    const term = q.search.toLowerCase();
    rows = rows.filter((r) => r.body.toLowerCase().includes(term));
  }
  if (q.traceId) rows = rows.filter((r) => r.trace_id === q.traceId);
  if (q.cursor && /^\d+$/.test(q.cursor)) {
    const c = Number(q.cursor);
    rows = rows.filter((r) => Number(r.ts_nano) < c);
  }
  const limit = Math.min(Math.max(q.limit ?? 200, 1), 500);
  const page = rows.slice(0, limit);
  const nextCursor = page.length >= limit ? (page[page.length - 1]?.ts_nano ?? null) : null;
  return { status: 'ok', rows: page, nextCursor };
};

// ── map+health (C2) ───────────────────────────────────────────────────────────
// Appended by the health-map slice: a 5-service call graph consistent with the
// seeded traces (checkout is the slow, error-prone hop) and a degraded health
// narrative that matches the demo inventory (checkout 1/2 tasks, loki 1/2,
// postgres replica lagging, the emails queue backing up). Shapes come from
// @swarmy/core (ServiceMapView / HealthNarrativeView) — the same types the real
// service returns.

import type {
  HealthEntryView,
  HealthNarrativeView,
  ServiceMapEdgeView,
  ServiceMapNodeView,
  ServiceMapView,
} from '@swarmy/core';

const MAP_NODES: ServiceMapNodeView[] = [
  { id: 'cdn-edge', callsPerMin: 140, errorRate: 0.001, p95Ms: 40, degraded: false },
  { id: 'web', callsPerMin: 86, errorRate: 0.004, p95Ms: 240, degraded: false },
  { id: 'api', callsPerMin: 118, errorRate: 0.012, p95Ms: 380, degraded: false },
  { id: 'checkout', callsPerMin: 22, errorRate: 0.062, p95Ms: 1820, degraded: true },
  { id: 'worker', callsPerMin: 12, errorRate: 0.009, p95Ms: 520, degraded: false },
];

const MAP_EDGES: ServiceMapEdgeView[] = [
  { from: 'web', to: 'cdn-edge', callsPerMin: 96, errorRate: 0.001, p95Ms: 38 },
  { from: 'web', to: 'api', callsPerMin: 74, errorRate: 0.011, p95Ms: 360 },
  { from: 'api', to: 'checkout', callsPerMin: 22, errorRate: 0.062, p95Ms: 1820 },
  { from: 'api', to: 'worker', callsPerMin: 12, errorRate: 0.009, p95Ms: 520 },
];

/** RED-derived reasons disappear when the suite is off (the store is the source). */
const RED_REASON = /error rate|p95 latency/;

const HEALTH_ENTRIES: HealthEntryView[] = [
  {
    kind: 'stack',
    name: 'storefront',
    status: 'degraded',
    reasons: [
      'service checkout running 1/2 tasks',
      'checkout: error rate 6.2% (target <5.0%)',
      'checkout: p95 latency 1.8s (target <1.5s)',
    ],
  },
  {
    kind: 'stack',
    name: 'data',
    status: 'degraded',
    reasons: [
      'database replica lag 12s (member postgres-replica-1, target <10s)',
      'queue depth rising (emails: 340 waiting)',
    ],
  },
  { kind: 'stack', name: 'platform', status: 'degraded', reasons: ['service loki running 1/2 tasks'] },
];

const HEALTH_TOP_REASONS = [
  'service checkout running 1/2 tasks',
  'service loki running 1/2 tasks',
  'database replica lag 12s (member postgres-replica-1, target <10s)',
  'queue depth rising (emails: 340 waiting)',
  'checkout: error rate 6.2% (target <5.0%)',
  'checkout: p95 latency 1.8s (target <1.5s)',
];

observability.handlers!['observability.map'] = (i, s): ServiceMapView => {
  const q = (i as { windowMinutes?: number } | undefined) ?? {};
  const windowMinutes = q.windowMinutes ?? 15;
  const st = state(s);
  if (!st.config.enabled) return { status: 'disabled', windowMinutes, nodes: [], edges: [] };
  return { status: 'ok', windowMinutes, nodes: MAP_NODES, edges: MAP_EDGES };
};

observability.handlers!['observability.health'] = (i, s): HealthNarrativeView => {
  const q = (i as { stack?: string } | undefined) ?? {};
  const st = state(s);
  const stripRed = (reasons: string[]): string[] =>
    st.config.enabled ? reasons : reasons.filter((r) => !RED_REASON.test(r));
  const entries = (q.stack ? HEALTH_ENTRIES.filter((e) => e.name === q.stack) : HEALTH_ENTRIES).map(
    (e) => ({ ...e, reasons: stripRed(e.reasons) }),
  );
  const reasons = stripRed(
    q.stack ? (entries[0]?.reasons ?? []) : HEALTH_TOP_REASONS,
  );
  const status = entries.length === 0 ? 'unknown' : entries.some((e) => e.status !== 'healthy') ? 'degraded' : 'healthy';
  return { status, reasons, entries, generatedAt: new Date().toISOString() };
};
