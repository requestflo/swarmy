/**
 * `observability.requestSeriesMany`: the request series of several parts of
 * one app in ONE ClickHouse query — what the app canvas draws as a sparkline
 * per part. Same entry-span rule and org scope as `buildRequestSeriesQuery`;
 * the rows carry their `ServiceName` and are split per service here.
 */
import { clampInt, lit, type RequestSeriesRow } from './observability-query';

/** At most this many service names per query (a part may be asked under two or three names). */
export const REQUEST_SERIES_MANY_MAX = 60;

export interface RequestSeriesManyQueryInput {
  /** The app (stack) the parts belong to. Required: a batch never spans apps. */
  stack: string;
  /** OTel service names (`OTEL_SERVICE_NAME`, else the swarm name). */
  services: string[];
  /** Lookback window in minutes (default 60). */
  windowMinutes?: number;
  /** Bucket width in seconds (default 120). */
  bucketSeconds?: number;
}

export interface RequestSeriesManyRow extends RequestSeriesRow {
  service: string;
}

export interface RequestSeriesManySeries {
  service: string;
  points: RequestSeriesRow[];
}

/** The distinct, non-empty names asked for, capped. */
export function requestSeriesNames(services: readonly string[]): string[] {
  return [...new Set(services.map((s) => s.trim()).filter(Boolean))].slice(0, REQUEST_SERIES_MANY_MAX);
}

/**
 * Entry spans (SERVER / CONSUMER / root) of the named services in one app,
 * bucketed per service: calls, errors and p95. Org-scoped first; every name
 * and the stack are escaped literals.
 */
export function buildRequestSeriesManyQuery(orgId: string, q: RequestSeriesManyQueryInput): string {
  const windowMinutes = clampInt(q.windowMinutes, 60, 1, 60 * 24 * 7);
  const bucketSeconds = clampInt(q.bucketSeconds, 120, 5, 3600);
  const names = requestSeriesNames(q.services);
  const where: string[] = [
    `ResourceAttributes['swarmy.org_id'] = ${lit(orgId)}`,
    `Timestamp >= now() - INTERVAL ${windowMinutes} MINUTE`,
    "(SpanKind IN ('SPAN_KIND_SERVER', 'SPAN_KIND_CONSUMER') OR ParentSpanId = '')",
    `ResourceAttributes['swarmy.stack'] = ${lit(q.stack)}`,
    // An empty list matches nothing rather than every service.
    names.length ? `ServiceName IN (${names.map(lit).join(', ')})` : '0',
  ];
  return [
    'SELECT',
    '  ServiceName AS service,',
    `  toString(toStartOfInterval(Timestamp, INTERVAL ${bucketSeconds} SECOND)) AS bucket,`,
    '  count() AS calls,',
    "  countIf(StatusCode = 'STATUS_CODE_ERROR') AS errors,",
    '  round(quantile(0.95)(Duration) / 1000000, 2) AS p95_ms',
    'FROM otel_traces',
    `WHERE ${where.join(' AND ')}`,
    'GROUP BY service, bucket',
    'ORDER BY service ASC, bucket ASC',
  ].join('\n');
}

/** Rows → one ascending series per service (ClickHouse's numbers can arrive as strings). */
export function groupRequestSeries(rows: readonly RequestSeriesManyRow[]): RequestSeriesManySeries[] {
  const by = new Map<string, RequestSeriesRow[]>();
  for (const r of rows) {
    const points = by.get(r.service) ?? [];
    points.push({ bucket: r.bucket, calls: Number(r.calls), errors: Number(r.errors), p95_ms: Number(r.p95_ms) });
    by.set(r.service, points);
  }
  return [...by].map(([service, points]) => ({ service, points: points.sort((a, b) => a.bucket.localeCompare(b.bucket)) }));
}
