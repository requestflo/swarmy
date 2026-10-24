/**
 * Structured-logs feed over `otel_logs` (columns per the exporter's schema:
 * Timestamp, TraceId, SpanId, SeverityText, SeverityNumber, ServiceName,
 * Body, ResourceAttributes, LogAttributes). Pure — no IO.
 *
 *  - Always `swarmy.org_id`-scoped (first predicate, non-negotiable) — and
 *    the dedupe subquery carries the same wall.
 *  - Closed `[from, to]` window in unix **milliseconds**, inlined as integers.
 *  - Optional filters: exact stack, exact service, severity floor, body
 *    ILIKE, exact trace id — every string routed through `lit()`.
 *  - Source: container output carries `swarmy.log.source=stdout` (the node
 *    agent stamps it); every other row was sent over OTLP. `auto` (default)
 *    prefers OTLP: a service's stdout lines show only when that service sent
 *    no OTLP log in the window, so an app that does both never shows twice.
 *  - Descending by Timestamp; keyset pagination via a nanosecond `ts_nano`
 *    cursor (digits-only or ignored) — page N+1 is `ts_nano < cursor`.
 */
import { LOG_SERVICE_LABEL, LOG_SOURCE_ATTR, type ObservabilityLogsInput } from '@swarmy/core';

function lit(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function clampInt(n: number | undefined, def: number, min: number, max: number): number {
  const v = Number.isFinite(n) ? Math.floor(n as number) : def;
  return Math.min(max, Math.max(min, v));
}

/**
 * Escape a user term for a ClickHouse `ILIKE` pattern: backslash the LIKE
 * metacharacters (`%`, `_`) and the escape char itself, BEFORE `lit()`.
 */
function likeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (m) => `\\${m}`);
}

const SOURCE = `ResourceAttributes['${LOG_SOURCE_ATTR}']`;
const SERVICE = `ResourceAttributes['${LOG_SERVICE_LABEL}']`;
const IS_STDOUT = `${SOURCE} = 'stdout'`;
const NOT_STDOUT = `${SOURCE} != 'stdout'`;

/** `auto`: stdout rows only for services that sent no OTLP log in the same org + window. */
function preferOtlp(scope: string[]): string {
  const otlpServices = `SELECT DISTINCT ${SERVICE} FROM otel_logs WHERE ${[...scope, NOT_STDOUT, `${SERVICE} != ''`].join(' AND ')}`;
  return `(${NOT_STDOUT} OR ${SERVICE} NOT IN (${otlpServices}))`;
}

export function buildLogsQuery(orgId: string, q: ObservabilityLogsInput): string {
  const limit = clampInt(q.limit, 200, 1, 500);
  const from = Math.max(0, Math.floor(Number.isFinite(q.from) ? q.from : 0));
  const to = Math.max(from, Math.floor(Number.isFinite(q.to) ? q.to : from));
  const scope = [
    // org scope is non-negotiable and always first.
    `ResourceAttributes['swarmy.org_id'] = ${lit(orgId)}`,
    `Timestamp >= fromUnixTimestamp64Milli(${from})`,
    `Timestamp <= fromUnixTimestamp64Milli(${to})`,
  ];
  const where = [...scope];
  if (q.stack) where.push(`ResourceAttributes['swarmy.stack'] = ${lit(q.stack)}`);
  if (q.serviceName) where.push(`ServiceName = ${lit(q.serviceName)}`);
  if (q.severityMin !== undefined) {
    where.push(`SeverityNumber >= ${clampInt(q.severityMin, 9, 1, 24)}`);
  }
  if (q.search) where.push(`Body ILIKE ${lit(`%${likeTerm(q.search)}%`)}`);
  if (q.traceId) where.push(`TraceId = ${lit(q.traceId)}`);
  const source = q.source ?? 'auto';
  if (source === 'stdout') where.push(IS_STDOUT);
  else if (source === 'otlp') where.push(NOT_STDOUT);
  else if (source === 'auto') where.push(preferOtlp(scope));
  // Timestamp keyset cursor: strictly older than the last row of the previous
  // page. Digits-only (validated at the input layer too) or it is ignored.
  if (q.cursor && /^\d{1,20}$/.test(q.cursor)) {
    where.push(`toUnixTimestamp64Nano(Timestamp) < ${q.cursor}`);
  }

  return [
    'SELECT',
    '  toString(Timestamp) AS timestamp,',
    '  toString(toUnixTimestamp64Nano(Timestamp)) AS ts_nano,',
    '  TraceId AS trace_id,',
    '  SpanId AS span_id,',
    '  SeverityText AS severity_text,',
    '  SeverityNumber AS severity_number,',
    '  ServiceName AS service_name,',
    '  Body AS body,',
    '  LogAttributes AS attributes,',
    `  if(${IS_STDOUT}, 'stdout', 'otlp') AS source`,
    'FROM otel_logs',
    `WHERE ${where.join(' AND ')}`,
    'ORDER BY Timestamp DESC',
    `LIMIT ${limit}`,
  ].join('\n');
}
