/**
 * Service-map query builders + composition (slice C2) — pure, no IO.
 *
 * The map is derived from `otel_traces` the classic way:
 *  - EDGES: a CLIENT/PRODUCER span in service A whose direct child (same
 *    TraceId, ParentSpanId = the client's SpanId) is a SERVER/CONSUMER span in
 *    service B is one call A → B. Grouping those pairs yields per-edge call
 *    rate, error rate, and p95 (measured on the server side — what B's callers
 *    actually experienced).
 *  - NODES: every service with entry spans (SERVER/CONSUMER or root) in the
 *    window, with the same RED aggregate. These rows double as the RED source
 *    for the health narrative (`health-summary.ts`).
 *
 * Every query is `swarmy.org_id`-scoped at the storage layer (both join sides),
 * all strings routed through `lit()`, all numbers clamped — same discipline as
 * `observability-query.ts`.
 */
import type { ServiceMapEdgeView, ServiceMapNodeView } from '@swarmy/core';

export interface ServiceMapQueryInput {
  /** Lookback window in minutes (default 15). */
  windowMinutes?: number;
}

/** One aggregated call edge (JSONEachRow shape). */
export interface ServiceMapEdgeRow {
  from_service: string;
  to_service: string;
  calls: number;
  /** 0..1 share of server-side spans with STATUS_CODE_ERROR. */
  error_rate: number;
  p95_ms: number;
}

/** One per-service RED aggregate over entry spans (JSONEachRow shape). */
export interface ServiceMapNodeRow {
  service_name: string;
  calls: number;
  error_rate: number;
  p95_ms: number;
}

export const MAP_DEFAULT_WINDOW_MINUTES = 15;
/** A node/edge is tinted degraded above these (mirrors health-summary targets). */
export const MAP_P95_DEGRADED_MS = 1500;
export const MAP_ERROR_RATE_DEGRADED = 0.05;

const ENTRY_KINDS = `('SPAN_KIND_SERVER', 'SPAN_KIND_CONSUMER')`;
const CALLER_KINDS = `('SPAN_KIND_CLIENT', 'SPAN_KIND_PRODUCER')`;

/** Single-quote-escape a literal for inlining into ClickHouse SQL. */
function lit(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function clampInt(n: number | undefined, def: number, min: number, max: number): number {
  const v = Number.isFinite(n) ? Math.floor(n as number) : def;
  return Math.min(max, Math.max(min, v));
}

/**
 * Edges: client/server span-kind pairs → `{from, to, calls, errorRate, p95}`.
 * Org scope is applied to BOTH join sides so a caller can never stitch another
 * org's spans into their graph. The client side gets a slightly padded window
 * so a call that started just before the cutoff still matches its server span.
 */
export function buildServiceMapQuery(orgId: string, q: ServiceMapQueryInput): string {
  const windowMinutes = clampInt(q.windowMinutes, MAP_DEFAULT_WINDOW_MINUTES, 1, 1440);
  return [
    'SELECT',
    '  c.ServiceName AS from_service,',
    '  s.ServiceName AS to_service,',
    '  count() AS calls,',
    `  round(countIf(s.StatusCode = 'STATUS_CODE_ERROR') / count(), 4) AS error_rate,`,
    '  round(quantile(0.95)(s.Duration) / 1000000, 2) AS p95_ms',
    'FROM otel_traces AS s',
    'INNER JOIN otel_traces AS c ON c.TraceId = s.TraceId AND c.SpanId = s.ParentSpanId',
    `WHERE s.ResourceAttributes['swarmy.org_id'] = ${lit(orgId)}`,
    `  AND c.ResourceAttributes['swarmy.org_id'] = ${lit(orgId)}`,
    `  AND s.Timestamp >= now() - INTERVAL ${windowMinutes} MINUTE`,
    `  AND c.Timestamp >= now() - INTERVAL ${windowMinutes + 5} MINUTE`,
    `  AND s.SpanKind IN ${ENTRY_KINDS}`,
    `  AND c.SpanKind IN ${CALLER_KINDS}`,
    '  AND c.ServiceName != s.ServiceName',
    'GROUP BY from_service, to_service',
    'ORDER BY calls DESC',
    'LIMIT 200',
  ].join('\n');
}

/**
 * Nodes: distinct services with entry spans in the window + their RED
 * aggregate. Root spans (no parent) count as entries too, so a service that is
 * only ever the head of a trace still appears on the map.
 */
export function buildServiceMapNodesQuery(orgId: string, q: ServiceMapQueryInput): string {
  const windowMinutes = clampInt(q.windowMinutes, MAP_DEFAULT_WINDOW_MINUTES, 1, 1440);
  return [
    'SELECT',
    '  ServiceName AS service_name,',
    '  count() AS calls,',
    `  round(countIf(StatusCode = 'STATUS_CODE_ERROR') / count(), 4) AS error_rate,`,
    '  round(quantile(0.95)(Duration) / 1000000, 2) AS p95_ms',
    'FROM otel_traces',
    `WHERE ResourceAttributes['swarmy.org_id'] = ${lit(orgId)}`,
    `  AND Timestamp >= now() - INTERVAL ${windowMinutes} MINUTE`,
    `  AND (SpanKind IN ${ENTRY_KINDS} OR ParentSpanId = '')`,
    'GROUP BY service_name',
    'ORDER BY calls DESC',
    'LIMIT 100',
  ].join('\n');
}

function perMin(calls: number, windowMinutes: number): number {
  const w = Math.max(1, windowMinutes);
  return Math.round((calls / w) * 100) / 100;
}

/** Whether a RED aggregate breaches the degraded thresholds. */
export function redDegraded(errorRate: number, p95Ms: number): boolean {
  return errorRate > MAP_ERROR_RATE_DEGRADED || p95Ms > MAP_P95_DEGRADED_MS;
}

/**
 * Fold raw node/edge rows into the wire view. Services that only appear on an
 * edge (e.g. a caller with zero entry spans of its own) still get a node so the
 * graph never has dangling edges.
 */
export function composeServiceMap(
  nodeRows: ServiceMapNodeRow[],
  edgeRows: ServiceMapEdgeRow[],
  windowMinutes: number,
): { nodes: ServiceMapNodeView[]; edges: ServiceMapEdgeView[] } {
  const nodes = new Map<string, ServiceMapNodeView>();
  for (const r of nodeRows) {
    nodes.set(r.service_name, {
      id: r.service_name,
      callsPerMin: perMin(r.calls, windowMinutes),
      errorRate: r.error_rate,
      p95Ms: r.p95_ms,
      degraded: redDegraded(r.error_rate, r.p95_ms),
    });
  }
  const edges: ServiceMapEdgeView[] = edgeRows.map((r) => ({
    from: r.from_service,
    to: r.to_service,
    callsPerMin: perMin(r.calls, windowMinutes),
    errorRate: r.error_rate,
    p95Ms: r.p95_ms,
  }));
  for (const e of edges) {
    for (const id of [e.from, e.to]) {
      if (!nodes.has(id)) {
        nodes.set(id, { id, callsPerMin: 0, errorRate: 0, p95Ms: 0, degraded: false });
      }
    }
  }
  return { nodes: [...nodes.values()], edges };
}
