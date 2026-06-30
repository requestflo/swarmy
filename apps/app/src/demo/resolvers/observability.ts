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

/** Per-minute series for the last `windowMinutes`, summed across services (or one). */
function buildSeries(metric: string, windowMinutes: number, bucketSeconds: number, service?: string): MetricsPoint[] {
  const services = service ? [service] : [...TELEMETRY_SERVICES];
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
  // The demo cluster's telemetry services don't map 1:1 to stacks; if a stack
  // filter is supplied we still return the relevant services (storefront → web,
  // api, checkout, cdn-edge; data → worker), otherwise all.
  const stackServices: Record<string, string[]> = {
    storefront: ['web', 'api', 'checkout', 'cdn-edge'],
    data: ['worker'],
  };
  const services = stack ? (stackServices[stack] ?? [...TELEMETRY_SERVICES]) : [...TELEMETRY_SERVICES];
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
      const points = buildSeries(q.metric, q.windowMinutes ?? 60, q.bucketSeconds ?? 60, q.service);
      return { status: 'ok', points };
    },
  },
};
