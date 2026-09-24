/**
 * Error tracking's ClickHouse tables (pure DDL render).
 *
 * The OTel collector owns `otel_*` (its exporter's `create_schema`); these
 * `swarmy_error_*` tables are owned by the error-tracking writer (the
 * controller's ingest path) and live in the SAME database, created through
 * the same idempotent-DDL-over-HTTP path the observability suite replays
 * (`applyInitDdl`): `CREATE TABLE IF NOT EXISTS`, then `MODIFY TTL` so a
 * retention change converges. Never delete from here — retention is TTL.
 *
 * Every table leads its sort key with `org_id`, and every read builder in
 * `query.ts` filters on it (the storage-layer org-scoping invariant).
 *
 * Issue state lives here too (not in the controller DB):
 *  - `swarmy_error_issues` is a ReplacingMergeTree keyed on
 *    (org_id, project_id, fingerprint); every status change INSERTs a newer
 *    `version` row and reads use `FINAL`.
 *  - counts / users / last-seen are aggregated from events on read.
 */

export const EVENTS_TABLE = 'swarmy_error_events';
export const ISSUES_TABLE = 'swarmy_error_issues';
export const RELEASES_TABLE = 'swarmy_error_releases';
export const ARTIFACTS_TABLE = 'swarmy_error_artifacts';

/** Source maps outlive event retention: a release is still symbolicated long after deploy. */
export const ARTIFACT_RETENTION_DAYS = 180;

function ident(db: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(db)) throw new Error(`invalid ClickHouse database name ${db}`);
  return db;
}

function days(n: number): number {
  return Math.min(365, Math.max(1, Math.floor(Number.isFinite(n) ? n : 7)));
}

/** The DDL statements, in order. Deterministic for a given input (golden-tested). */
export function renderErrorsSchema(opts: { database: string; retentionDays: number }): string[] {
  const db = ident(opts.database);
  const ttl = days(opts.retentionDays);
  return [
    `CREATE TABLE IF NOT EXISTS ${db}.${EVENTS_TABLE} (
  org_id LowCardinality(String),
  project_id UInt32,
  stack LowCardinality(String),
  event_id String,
  fingerprint String,
  timestamp DateTime64(3, 'UTC'),
  received_at DateTime64(3, 'UTC'),
  level LowCardinality(String),
  platform LowCardinality(String),
  exc_type String,
  exc_value String,
  title String,
  culprit String,
  transaction String,
  release String,
  environment LowCardinality(String),
  server_name String,
  user_key String,
  user_id String,
  user_email String,
  user_ip String,
  trace_id String,
  span_id String,
  replay_id String,
  sdk_name LowCardinality(String),
  sdk_version LowCardinality(String),
  handled UInt8,
  tags Map(String, String),
  payload String CODEC(ZSTD(3)),
  INDEX idx_trace trace_id TYPE bloom_filter GRANULARITY 4,
  INDEX idx_event event_id TYPE bloom_filter GRANULARITY 4
) ENGINE = MergeTree
PARTITION BY toDate(timestamp)
ORDER BY (org_id, project_id, fingerprint, timestamp)
TTL toDateTime(timestamp) + INTERVAL ${ttl} DAY`,
    `ALTER TABLE ${db}.${EVENTS_TABLE} MODIFY TTL toDateTime(timestamp) + INTERVAL ${ttl} DAY`,
    `CREATE TABLE IF NOT EXISTS ${db}.${ISSUES_TABLE} (
  org_id LowCardinality(String),
  project_id UInt32,
  stack LowCardinality(String),
  fingerprint String,
  title String,
  culprit String,
  exc_type String,
  level LowCardinality(String),
  platform LowCardinality(String),
  status LowCardinality(String),
  resolved_in_release String,
  status_changed_at DateTime64(3, 'UTC'),
  status_by String,
  first_seen DateTime64(3, 'UTC'),
  first_release String,
  regressed_at DateTime64(3, 'UTC'),
  version UInt64
) ENGINE = ReplacingMergeTree(version)
ORDER BY (org_id, project_id, fingerprint)`,
    `CREATE TABLE IF NOT EXISTS ${db}.${RELEASES_TABLE} (
  org_id LowCardinality(String),
  project_id UInt32,
  stack LowCardinality(String),
  version String,
  commit_sha String,
  environment LowCardinality(String),
  source LowCardinality(String),
  swarmy_release_id String,
  first_seen DateTime64(3, 'UTC'),
  deployed_at DateTime64(3, 'UTC'),
  updated UInt64
) ENGINE = ReplacingMergeTree(updated)
ORDER BY (org_id, project_id, version)`,
    `CREATE TABLE IF NOT EXISTS ${db}.${ARTIFACTS_TABLE} (
  org_id LowCardinality(String),
  project_id UInt32,
  release String,
  name String,
  debug_id String,
  kind LowCardinality(String),
  size UInt64,
  content String CODEC(ZSTD(6)),
  uploaded_at DateTime64(3, 'UTC')
) ENGINE = ReplacingMergeTree(uploaded_at)
ORDER BY (org_id, project_id, release, name)
TTL toDateTime(uploaded_at) + INTERVAL ${ARTIFACT_RETENTION_DAYS} DAY`,
  ];
}
