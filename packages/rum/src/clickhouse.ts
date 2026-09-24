/**
 * RUM storage in ClickHouse — DDL and org-scoped read builders. Pure strings.
 *
 * The tables live in the SAME database as the collector's otel_* tables (one
 * store, one DSN). The collector owns otel_*; swarmy owns swarmy_rum_*.
 * Retention is a ClickHouse TTL on a per-row `retention_days` column, so each
 * app keeps exactly as long as its settings say — no delete loop.
 *
 * Every read is scoped `org_id = lit(orgId) AND app = lit(app)`, every string
 * goes through `lit()`, every number through `clampInt()`.
 */

export const RUM_EVENTS_TABLE = 'swarmy_rum_events';
export const RUM_REPLAYS_TABLE = 'swarmy_rum_replays';
/** Owned by the error-tracking slice; read for the replay timeline when present. */
export const ERROR_EVENTS_TABLE = 'swarmy_error_events';

export function lit(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export function clampInt(n: number | undefined, def: number, min: number, max: number): number {
  const v = Number.isFinite(n) ? Math.floor(n as number) : def;
  return Math.min(max, Math.max(min, v));
}

export const RUM_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ${RUM_EVENTS_TABLE} (
  ts DateTime64(3, 'UTC'),
  org_id LowCardinality(String),
  app LowCardinality(String),
  retention_days UInt16,
  kind LowCardinality(String),
  host LowCardinality(String),
  path String,
  referrer_host LowCardinality(String),
  utm_source LowCardinality(String),
  utm_medium LowCardinality(String),
  utm_campaign LowCardinality(String),
  country LowCardinality(String),
  device LowCardinality(String),
  browser LowCardinality(String),
  visitor_hash UInt64,
  session_id String,
  user_id String,
  event_name LowCardinality(String),
  engaged_ms UInt32
) ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (org_id, app, ts)
TTL toDateTime(ts) + toIntervalDay(retention_days)`,
  `CREATE TABLE IF NOT EXISTS ${RUM_REPLAYS_TABLE} (
  org_id LowCardinality(String),
  app LowCardinality(String),
  session_id String,
  seq UInt32,
  day Date,
  start_ts DateTime64(3, 'UTC'),
  end_ts DateTime64(3, 'UTC'),
  events UInt32,
  bytes UInt32,
  first_path String,
  clicks UInt32,
  errors UInt32,
  requests UInt32,
  trace_ids Array(String),
  user_id String,
  country LowCardinality(String),
  device LowCardinality(String),
  browser LowCardinality(String),
  object_key String,
  retention_days UInt16,
  inserted_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(inserted_at)
PARTITION BY toYYYYMM(day)
ORDER BY (org_id, app, session_id, seq)
TTL toDateTime(start_ts) + toIntervalDay(retention_days)`,
];

function scope(orgId: string, app: string): string {
  return `org_id = ${lit(orgId)} AND app = ${lit(app)}`;
}

export interface AnalyticsWindow {
  /** Look-back in days (1..90). */
  days?: number;
}

function sinceDays(q: AnalyticsWindow): number {
  return clampInt(q.days, 7, 1, 90);
}

/** KPI row: daily-unique visitors, pageviews, bounce rate, median visit seconds. */
export function buildOverviewQuery(orgId: string, app: string, q: AnalyticsWindow): string {
  const d = sinceDays(q);
  return `SELECT
  count() AS visits,
  sum(pv) AS pageviews,
  round(countIf(pv = 1) / greatest(count(), 1), 4) AS bounce_rate,
  round(quantile(0.5)(dur_s), 1) AS median_visit_s,
  uniqExactIf(user_id, user_id != '') AS signed_in
FROM (
  SELECT visitor_hash, toDate(ts) AS d,
    countIf(kind = 'pv') AS pv,
    greatest(dateDiff('millisecond', min(ts), max(ts)), sum(engaged_ms)) / 1000 AS dur_s,
    anyIf(user_id, user_id != '') AS user_id
  FROM ${RUM_EVENTS_TABLE}
  WHERE ${scope(orgId, app)} AND ts >= now() - INTERVAL ${d} DAY
  GROUP BY visitor_hash, d
  HAVING pv > 0
)`;
}

/** Visitors + pageviews per UTC day. */
export function buildSeriesQuery(orgId: string, app: string, q: AnalyticsWindow): string {
  const d = sinceDays(q);
  return `SELECT toString(toDate(ts)) AS day,
  uniqExact(visitor_hash) AS visitors,
  countIf(kind = 'pv') AS pageviews
FROM ${RUM_EVENTS_TABLE}
WHERE ${scope(orgId, app)} AND ts >= now() - INTERVAL ${d} DAY
GROUP BY day ORDER BY day`;
}

export type Breakdown = 'path' | 'referrer_host' | 'country' | 'device' | 'browser' | 'utm_source' | 'utm_campaign';
const BREAKDOWNS = new Set<Breakdown>(['path', 'referrer_host', 'country', 'device', 'browser', 'utm_source', 'utm_campaign']);

/** Top-N breakdown by one dimension (a fixed allowlist — never interpolated freely). */
export function buildBreakdownQuery(
  orgId: string,
  app: string,
  dim: Breakdown,
  q: AnalyticsWindow & { limit?: number },
): string {
  if (!BREAKDOWNS.has(dim)) throw new Error(`unknown breakdown ${String(dim)}`);
  const d = sinceDays(q);
  const limit = clampInt(q.limit, 10, 1, 100);
  return `SELECT ${dim} AS key,
  uniqExact(visitor_hash, toDate(ts)) AS visitors,
  countIf(kind = 'pv') AS pageviews
FROM ${RUM_EVENTS_TABLE}
WHERE ${scope(orgId, app)} AND ts >= now() - INTERVAL ${d} DAY AND kind = 'pv'
GROUP BY key ORDER BY visitors DESC, key LIMIT ${limit}`;
}

/** Visitors seen in the last N minutes (the "live" counter). */
export function buildLiveQuery(orgId: string, app: string, minutes = 5): string {
  const m = clampInt(minutes, 5, 1, 60);
  return `SELECT uniqExact(visitor_hash) AS visitors, countIf(kind = 'pv') AS pageviews
FROM ${RUM_EVENTS_TABLE}
WHERE ${scope(orgId, app)} AND ts >= now() - INTERVAL ${m} MINUTE`;
}

/** Identified mode: the signed-in visitors, most recent first. */
export function buildUsersQuery(orgId: string, app: string, q: AnalyticsWindow & { limit?: number }): string {
  const d = sinceDays(q);
  const limit = clampInt(q.limit, 20, 1, 200);
  return `SELECT user_id,
  countIf(kind = 'pv') AS pageviews,
  uniqExact(session_id) AS sessions,
  toString(max(ts)) AS last_seen,
  any(country) AS country,
  argMax(session_id, ts) AS last_session
FROM ${RUM_EVENTS_TABLE}
WHERE ${scope(orgId, app)} AND ts >= now() - INTERVAL ${d} DAY AND user_id != ''
GROUP BY user_id ORDER BY max(ts) DESC LIMIT ${limit}`;
}

// ── replays ────────────────────────────────────────────────────────────

export interface ReplayListInput {
  days?: number;
  withErrors?: boolean;
  userId?: string;
  limit?: number;
}

export function buildReplayListQuery(orgId: string, app: string, q: ReplayListInput): string {
  const d = clampInt(q.days, 7, 1, 365);
  const limit = clampInt(q.limit, 50, 1, 200);
  const having: string[] = [];
  if (q.withErrors) having.push('errors > 0');
  const where = [`${scope(orgId, app)}`, `day >= today() - ${d}`];
  if (q.userId) where.push(`user_id = ${lit(q.userId)}`);
  return `SELECT session_id,
  toString(min(start_ts)) AS started_at,
  toString(max(end_ts)) AS ended_at,
  dateDiff('millisecond', min(start_ts), max(end_ts)) AS duration_ms,
  sum(events) AS events,
  sum(bytes) AS bytes,
  sum(clicks) AS clicks,
  sum(errors) AS errors,
  sum(requests) AS requests,
  count() AS chunks,
  argMin(first_path, seq) AS first_path,
  anyIf(user_id, user_id != '') AS user_id,
  any(country) AS country,
  any(device) AS device,
  any(browser) AS browser
FROM ${RUM_REPLAYS_TABLE} FINAL
WHERE ${where.join(' AND ')}
GROUP BY session_id
${having.length ? `HAVING ${having.join(' AND ')}` : ''}
ORDER BY min(start_ts) DESC
LIMIT ${limit}`;
}

/** The chunk list (object keys in order) + trace ids for one session. */
export function buildReplayChunksQuery(orgId: string, app: string, sessionId: string): string {
  return `SELECT seq, object_key, toString(start_ts) AS start_ts, toString(end_ts) AS end_ts, trace_ids,
  user_id, country, device, browser, day
FROM ${RUM_REPLAYS_TABLE} FINAL
WHERE ${scope(orgId, app)} AND session_id = ${lit(sessionId)}
ORDER BY seq
LIMIT 5000`;
}

/** Sessions of one user (GDPR delete-by-user resolves ids through this). */
export function buildUserSessionsQuery(orgId: string, app: string | null, userId: string): string {
  const appClause = app ? ` AND app = ${lit(app)}` : '';
  return `SELECT DISTINCT app, session_id, toString(day) AS day FROM ${RUM_REPLAYS_TABLE}
WHERE org_id = ${lit(orgId)}${appClause} AND user_id = ${lit(userId)}
LIMIT 10000`;
}

const TRACE_ID_RE = /^[0-9a-f]{32}$/;

/**
 * Server spans for a replay's requests: the traces the browser started
 * (traceparent it generated or read from Server-Timing) PLUS any span tagged
 * with the session id. Org-scoped on the resource attribute like every
 * observability read.
 */
export function buildReplayRequestsQuery(
  orgId: string,
  sessionId: string,
  traceIds: readonly string[],
  window: { fromMs: number; toMs: number },
): string {
  const ids = traceIds.filter((t) => TRACE_ID_RE.test(t)).slice(0, 500);
  const idClause = ids.length ? `TraceId IN (${ids.map(lit).join(', ')})` : '0';
  const from = Math.floor(window.fromMs / 1000) - 60;
  const to = Math.ceil(window.toMs / 1000) + 60;
  return `SELECT TraceId AS trace_id, SpanId AS span_id, ParentSpanId AS parent_span_id,
  ServiceName AS service_name, SpanName AS span_name,
  toUnixTimestamp64Milli(Timestamp) AS start_ms,
  round(Duration / 1000000, 2) AS duration_ms,
  StatusCode AS status_code,
  coalesce(nullIf(SpanAttributes['http.request.method'], ''), SpanAttributes['http.method']) AS method,
  coalesce(nullIf(SpanAttributes['url.path'], ''), nullIf(SpanAttributes['http.target'], ''), SpanAttributes['http.route']) AS path,
  coalesce(nullIf(SpanAttributes['http.response.status_code'], ''), SpanAttributes['http.status_code']) AS http_status
FROM otel_traces
WHERE ResourceAttributes['swarmy.org_id'] = ${lit(orgId)}
  AND Timestamp >= toDateTime(${from}) AND Timestamp <= toDateTime(${to})
  AND (${idClause} OR SpanAttributes['swarmy.session_id'] = ${lit(sessionId)})
  AND SpanKind IN ('SPAN_KIND_SERVER', 'Server')
ORDER BY Timestamp
LIMIT 1000`;
}

/** Logs correlated with the replay's traces. */
export function buildReplayLogsQuery(orgId: string, traceIds: readonly string[], window: { fromMs: number; toMs: number }): string {
  const ids = traceIds.filter((t) => TRACE_ID_RE.test(t)).slice(0, 500);
  if (ids.length === 0) return '';
  const from = Math.floor(window.fromMs / 1000) - 60;
  const to = Math.ceil(window.toMs / 1000) + 60;
  return `SELECT toUnixTimestamp64Milli(Timestamp) AS ts_ms, SeverityText AS severity, ServiceName AS service_name,
  Body AS body, TraceId AS trace_id
FROM otel_logs
WHERE ResourceAttributes['swarmy.org_id'] = ${lit(orgId)}
  AND Timestamp >= toDateTime(${from}) AND Timestamp <= toDateTime(${to})
  AND TraceId IN (${ids.map(lit).join(', ')})
ORDER BY Timestamp
LIMIT 1000`;
}

/** Server-side errors (error-tracking slice) linked to this replay. */
export function buildReplayErrorsQuery(orgId: string, sessionId: string): string {
  return `SELECT * FROM ${ERROR_EVENTS_TABLE}
WHERE org_id = ${lit(orgId)} AND replay_id = ${lit(sessionId)}
ORDER BY timestamp
LIMIT 200`;
}

// ── GDPR / retention ───────────────────────────────────────────────────

/** Lightweight deletes for one session (both tables). */
export function buildDeleteSessionStatements(orgId: string, app: string, sessionId: string): string[] {
  const w = `${scope(orgId, app)} AND session_id = ${lit(sessionId)}`;
  return [`DELETE FROM ${RUM_EVENTS_TABLE} WHERE ${w}`, `DELETE FROM ${RUM_REPLAYS_TABLE} WHERE ${w}`];
}

/** Lightweight deletes for every row tied to a user id. */
export function buildDeleteUserStatements(orgId: string, app: string | null, userId: string): string[] {
  const w = `org_id = ${lit(orgId)}${app ? ` AND app = ${lit(app)}` : ''} AND user_id = ${lit(userId)}`;
  return [`DELETE FROM ${RUM_EVENTS_TABLE} WHERE ${w}`, `DELETE FROM ${RUM_REPLAYS_TABLE} WHERE ${w}`];
}

/** Storage footprint per table for one app (settings forecast). */
export function buildFootprintQuery(orgId: string, app: string): string {
  return `SELECT
  (SELECT count() FROM ${RUM_EVENTS_TABLE} WHERE ${scope(orgId, app)}) AS event_rows,
  (SELECT uniqExact(session_id) FROM ${RUM_REPLAYS_TABLE} WHERE ${scope(orgId, app)}) AS replay_sessions,
  (SELECT sum(bytes) FROM ${RUM_REPLAYS_TABLE} WHERE ${scope(orgId, app)}) AS replay_bytes,
  (SELECT uniqExact(session_id) FROM ${RUM_REPLAYS_TABLE} WHERE ${scope(orgId, app)} AND day >= today() - 1) AS replay_sessions_24h,
  (SELECT uniqExact(visitor_hash) FROM ${RUM_EVENTS_TABLE} WHERE ${scope(orgId, app)} AND ts >= now() - INTERVAL 1 DAY) AS visitors_24h`;
}

