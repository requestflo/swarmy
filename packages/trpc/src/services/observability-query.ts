/**
 * Pure ClickHouse SQL builders for the observability read path.
 *
 * No IO — these return parameterized SQL strings the service runs over the
 * ClickHouse HTTP interface. Every query is constrained by `swarmy_org_id` so a
 * caller can never read another org's telemetry (org-scoping at the storage
 * layer). The table layout mirrors the OTel Collector ClickHouse exporter
 * (`otel_traces`) plus a swarmy resource-metrics table (`otel_metrics_gauge`).
 */

export interface TracesQueryInput {
  service?: string;
  stack?: string;
  /** Only spans whose duration exceeds this (ms). */
  minDurationMs?: number;
  /** Only error spans (status_code != 'STATUS_CODE_OK'). */
  errorsOnly?: boolean;
  /** Lookback window in minutes (default 60). */
  windowMinutes?: number;
  limit?: number;
}

export interface MetricsQueryInput {
  /** Metric name, e.g. `http.server.duration` or `system.cpu.utilization`. */
  metric: string;
  service?: string;
  stack?: string;
  windowMinutes?: number;
  /** Bucket width in seconds for the time series (default 60). */
  bucketSeconds?: number;
}

/** One row of the trace list — a root-span summary, Jaeger-lite. */
export interface TraceRow {
  trace_id: string;
  span_id: string;
  service_name: string;
  span_name: string;
  duration_ms: number;
  status_code: string;
  span_count: number;
  start_time: string;
}

export interface MetricsPoint {
  bucket: string;
  value: number;
}

/** Single-quote-escape a literal for inlining into ClickHouse SQL. */
function lit(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function clampInt(n: number | undefined, def: number, min: number, max: number): number {
  const v = Number.isFinite(n) ? Math.floor(n as number) : def;
  return Math.min(max, Math.max(min, v));
}

export function buildTracesQuery(orgId: string, q: TracesQueryInput): string {
  const windowMinutes = clampInt(q.windowMinutes, 60, 1, 60 * 24 * 7);
  const limit = clampInt(q.limit, 100, 1, 500);
  const where: string[] = [
    // org scope is non-negotiable and always first.
    `ResourceAttributes['swarmy.org_id'] = ${lit(orgId)}`,
    `Timestamp >= now() - INTERVAL ${windowMinutes} MINUTE`,
    // Trace list = root spans only (no parent) so each row is one trace.
    `ParentSpanId = ''`,
  ];
  if (q.service) where.push(`ServiceName = ${lit(q.service)}`);
  if (q.stack) where.push(`ResourceAttributes['swarmy.stack'] = ${lit(q.stack)}`);
  if (q.minDurationMs && q.minDurationMs > 0) {
    where.push(`Duration >= ${Math.floor(q.minDurationMs) * 1_000_000}`); // ns
  }
  if (q.errorsOnly) where.push(`StatusCode != 'STATUS_CODE_OK'`);

  return [
    'SELECT',
    '  TraceId AS trace_id,',
    '  SpanId AS span_id,',
    '  ServiceName AS service_name,',
    '  SpanName AS span_name,',
    '  round(Duration / 1000000, 2) AS duration_ms,',
    '  StatusCode AS status_code,',
    '  (SELECT count() FROM otel_traces t2 WHERE t2.TraceId = otel_traces.TraceId) AS span_count,',
    '  toString(Timestamp) AS start_time',
    'FROM otel_traces',
    `WHERE ${where.join(' AND ')}`,
    'ORDER BY Timestamp DESC',
    `LIMIT ${limit}`,
  ].join('\n');
}

export function buildMetricsSeriesQuery(orgId: string, q: MetricsQueryInput): string {
  const windowMinutes = clampInt(q.windowMinutes, 60, 1, 60 * 24 * 7);
  const bucketSeconds = clampInt(q.bucketSeconds, 60, 5, 3600);
  const where: string[] = [
    `ResourceAttributes['swarmy.org_id'] = ${lit(orgId)}`,
    `MetricName = ${lit(q.metric)}`,
    `TimeUnix >= now() - INTERVAL ${windowMinutes} MINUTE`,
  ];
  if (q.service) where.push(`ServiceName = ${lit(q.service)}`);
  if (q.stack) where.push(`ResourceAttributes['swarmy.stack'] = ${lit(q.stack)}`);

  return [
    'SELECT',
    `  toString(toStartOfInterval(TimeUnix, INTERVAL ${bucketSeconds} SECOND)) AS bucket,`,
    '  round(avg(Value), 4) AS value',
    'FROM otel_metrics_gauge',
    `WHERE ${where.join(' AND ')}`,
    'GROUP BY bucket',
    'ORDER BY bucket ASC',
  ].join('\n');
}
