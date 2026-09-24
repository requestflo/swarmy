/**
 * Pure, org-scoped ClickHouse SQL for error tracking (no IO).
 *
 * Every statement filters `org_id = lit(orgId)` on EVERY table it touches
 * (both sides of a join), routes every string through {@link lit} and clamps
 * every number — the same storage-layer scoping contract as
 * `observability-query.ts`. Inserts never go through SQL text: rows are sent
 * as a JSONEachRow body (see store.ts), so only the table name is templated.
 */
import { ARTIFACTS_TABLE, EVENTS_TABLE, ISSUES_TABLE, RELEASES_TABLE } from './schema';

export const ISSUE_STATUSES = ['unresolved', 'resolved', 'resolved_next_release', 'ignored'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export function lit(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export function clampInt(n: number | undefined, def: number, min: number, max: number): number {
  const v = Number.isFinite(n) ? Math.floor(n as number) : def;
  return Math.min(max, Math.max(min, v));
}

function ident(db: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(db)) throw new Error(`invalid ClickHouse database name ${db}`);
  return db;
}

/** ClickHouse DateTime64(3) literal text for JSONEachRow (UTC). */
export function chTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
}

const scope = (orgId: string, projectId: number, alias = '') =>
  `${alias}org_id = ${lit(orgId)} AND ${alias}project_id = ${clampInt(projectId, 0, 0, 4_294_967_295)}`;

/* ----------------------------------------------------------------------------
 * Row shapes (JSONEachRow)
 * ------------------------------------------------------------------------- */

export interface IssueStateRow {
  fingerprint: string;
  title: string;
  culprit: string;
  exc_type: string;
  level: string;
  platform: string;
  status: IssueStatus;
  resolved_in_release: string;
  status_changed_at: string;
  status_by: string;
  first_seen: string;
  first_release: string;
  regressed_at: string;
  version: string | number;
}

export interface IssueListRow extends IssueStateRow {
  count: string | number;
  users: string | number;
  last_seen: string;
  last_release: string;
  count_24h: string | number;
}

export interface IssueTrendRow {
  fingerprint: string;
  bucket: string;
  c: string | number;
}

export interface EventListRow {
  event_id: string;
  timestamp: string;
  release: string;
  environment: string;
  server_name: string;
  user_key: string;
  trace_id: string;
  span_id: string;
  replay_id: string;
  title: string;
  level: string;
}

export interface EventPayloadRow extends EventListRow {
  payload: string;
  project_id: number;
  fingerprint: string;
}

export interface TagRow {
  k: string;
  v: string;
  c: string | number;
}

export interface ReleaseRow {
  version: string;
  commit_sha: string;
  environment: string;
  source: string;
  swarmy_release_id: string;
  first_seen: string;
  deployed_at: string;
  new_issues: string | number;
  events: string | number;
}

export interface SpikeRow {
  project_id: number;
  stack: string;
  fingerprint: string;
  title: string;
  recent: string | number;
  baseline: string | number;
}

/* ----------------------------------------------------------------------------
 * Issue state
 * ------------------------------------------------------------------------- */

const ISSUE_COLS =
  'fingerprint, title, culprit, exc_type, level, platform, status, resolved_in_release, status_changed_at, status_by, first_seen, first_release, regressed_at, version';

/** Current state of specific issues (ingest-side lookup). */
export function buildIssueStateQuery(db: string, orgId: string, projectId: number, fingerprints: string[]): string {
  const fps = fingerprints.slice(0, 500).map(lit).join(', ') || "''";
  return `SELECT ${ISSUE_COLS} FROM ${ident(db)}.${ISSUES_TABLE} FINAL WHERE ${scope(orgId, projectId)} AND fingerprint IN (${fps})`;
}

export interface IssuesListInput {
  projectId: number;
  status?: IssueStatus | 'all';
  /** Free-text filter over title / culprit. */
  query?: string;
  release?: string;
  sort?: 'last_seen' | 'first_seen' | 'count' | 'users';
  limit?: number;
}

/** The Issues list: issue state ⋈ event aggregates over the retained window. */
export function buildIssuesListQuery(db: string, orgId: string, q: IssuesListInput): string {
  const d = ident(db);
  const limit = clampInt(q.limit, 50, 1, 200);
  const where: string[] = [];
  const status = q.status ?? 'unresolved';
  if (status !== 'all') where.push(`i.status = ${lit(status)}`);
  if (q.query?.trim()) {
    const needle = lit(q.query.trim().slice(0, 200));
    where.push(`(positionCaseInsensitive(i.title, ${needle}) > 0 OR positionCaseInsensitive(i.culprit, ${needle}) > 0)`);
  }
  if (q.release?.trim()) where.push(`(i.first_release = ${lit(q.release.trim())} OR e.last_release = ${lit(q.release.trim())})`);
  const sort =
    q.sort === 'first_seen' ? 'i.first_seen DESC'
    : q.sort === 'count' ? 'e.count DESC'
    : q.sort === 'users' ? 'e.users DESC'
    : 'e.last_seen DESC';
  return `SELECT i.fingerprint AS fingerprint, i.title AS title, i.culprit AS culprit, i.exc_type AS exc_type, i.level AS level,
  i.platform AS platform, i.status AS status, i.resolved_in_release AS resolved_in_release, i.status_changed_at AS status_changed_at,
  i.status_by AS status_by, i.first_seen AS first_seen, i.first_release AS first_release, i.regressed_at AS regressed_at, i.version AS version,
  e.count AS count, e.users AS users, e.last_seen AS last_seen, e.last_release AS last_release, e.count_24h AS count_24h
FROM (SELECT * FROM ${d}.${ISSUES_TABLE} FINAL WHERE ${scope(orgId, q.projectId)}) AS i
LEFT JOIN (
  SELECT fingerprint, count() AS count, uniqExactIf(user_key, user_key != '') AS users, max(timestamp) AS last_seen,
    argMax(release, timestamp) AS last_release, countIf(timestamp >= now64(3) - INTERVAL 24 HOUR) AS count_24h
  FROM ${d}.${EVENTS_TABLE} WHERE ${scope(orgId, q.projectId)} GROUP BY fingerprint
) AS e ON e.fingerprint = i.fingerprint
${where.length ? `WHERE ${where.join(' AND ')}` : ''}
ORDER BY ${sort}
LIMIT ${limit}`;
}

/** Hourly counts over the last 24 h for the listed issues (the list's sparkline). */
export function buildIssueTrendQuery(db: string, orgId: string, projectId: number, fingerprints: string[]): string {
  const fps = fingerprints.slice(0, 200).map(lit).join(', ') || "''";
  return `SELECT fingerprint, toStartOfHour(timestamp) AS bucket, count() AS c FROM ${ident(db)}.${EVENTS_TABLE}
WHERE ${scope(orgId, projectId)} AND fingerprint IN (${fps}) AND timestamp >= now64(3) - INTERVAL 24 HOUR
GROUP BY fingerprint, bucket ORDER BY fingerprint, bucket`;
}

/** One issue with its aggregates (detail header). */
export function buildIssueDetailQuery(db: string, orgId: string, projectId: number, fingerprint: string): string {
  return buildIssuesListQuery(db, orgId, { projectId, status: 'all', limit: 1 }).replace(
    `FINAL WHERE ${scope(orgId, projectId)}) AS i`,
    `FINAL WHERE ${scope(orgId, projectId)} AND fingerprint = ${lit(fingerprint)}) AS i`,
  );
}

/** Recent events of an issue (newest first), without payloads. */
export function buildIssueEventsQuery(db: string, orgId: string, projectId: number, fingerprint: string, limit?: number): string {
  return `SELECT event_id, timestamp, release, environment, server_name, user_key, trace_id, span_id, replay_id, title, level
FROM ${ident(db)}.${EVENTS_TABLE} WHERE ${scope(orgId, projectId)} AND fingerprint = ${lit(fingerprint)}
ORDER BY timestamp DESC LIMIT ${clampInt(limit, 25, 1, 100)}`;
}

/** One full event (the latest of the issue, or a specific `eventId`). */
export function buildEventPayloadQuery(db: string, orgId: string, projectId: number, fingerprint: string, eventId?: string): string {
  const extra = eventId ? ` AND event_id = ${lit(eventId.replace(/-/g, '').toLowerCase())}` : '';
  return `SELECT event_id, timestamp, release, environment, server_name, user_key, trace_id, span_id, replay_id, title, level, payload, project_id, fingerprint
FROM ${ident(db)}.${EVENTS_TABLE} WHERE ${scope(orgId, projectId)} AND fingerprint = ${lit(fingerprint)}${extra}
ORDER BY timestamp DESC LIMIT 1`;
}

/** Top values per tag (plus release / environment / server as pseudo-tags). */
export function buildIssueTagsQuery(db: string, orgId: string, projectId: number, fingerprint: string): string {
  return `SELECT k, v, count() AS c FROM ${ident(db)}.${EVENTS_TABLE}
ARRAY JOIN arrayConcat(mapKeys(tags), ['release', 'environment', 'server_name']) AS k,
           arrayConcat(mapValues(tags), [release, environment, server_name]) AS v
WHERE ${scope(orgId, projectId)} AND fingerprint = ${lit(fingerprint)} AND v != ''
GROUP BY k, v ORDER BY k, c DESC LIMIT 5 BY k`;
}

/** Issues that fired inside one trace (the trace view's "errors" link). */
export function buildIssuesForTraceQuery(db: string, orgId: string, traceId: string): string {
  return `SELECT project_id, stack, fingerprint, any(title) AS title, count() AS c, min(timestamp) AS first
FROM ${ident(db)}.${EVENTS_TABLE} WHERE org_id = ${lit(orgId)} AND trace_id = ${lit(traceId.toLowerCase())}
GROUP BY project_id, stack, fingerprint ORDER BY first LIMIT 50`;
}

/* ----------------------------------------------------------------------------
 * Releases + artifacts
 * ------------------------------------------------------------------------- */

export function buildReleasesQuery(db: string, orgId: string, projectId: number, limit?: number): string {
  const d = ident(db);
  return `SELECT r.version AS version, r.commit_sha AS commit_sha, r.environment AS environment, r.source AS source,
  r.swarmy_release_id AS swarmy_release_id, r.first_seen AS first_seen, r.deployed_at AS deployed_at,
  n.new_issues AS new_issues, ev.events AS events
FROM (SELECT * FROM ${d}.${RELEASES_TABLE} FINAL WHERE ${scope(orgId, projectId)}) AS r
LEFT JOIN (SELECT first_release AS version, count() AS new_issues FROM ${d}.${ISSUES_TABLE} FINAL WHERE ${scope(orgId, projectId)} GROUP BY first_release) AS n ON n.version = r.version
LEFT JOIN (SELECT release AS version, count() AS events FROM ${d}.${EVENTS_TABLE} WHERE ${scope(orgId, projectId)} GROUP BY release) AS ev ON ev.version = r.version
ORDER BY greatest(r.deployed_at, r.first_seen) DESC LIMIT ${clampInt(limit, 25, 1, 200)}`;
}

/** One release row (for "the deploy that introduced this issue"). */
export function buildReleaseQuery(db: string, orgId: string, projectId: number, version: string): string {
  return `SELECT version, commit_sha, environment, source, swarmy_release_id, first_seen, deployed_at, 0 AS new_issues, 0 AS events
FROM ${ident(db)}.${RELEASES_TABLE} FINAL WHERE ${scope(orgId, projectId)} AND version = ${lit(version)} LIMIT 1`;
}

export interface ArtifactIndexRow {
  release: string;
  name: string;
  debug_id: string;
  kind: string;
  size: string | number;
  uploaded_at: string;
}

/** Artifact names for a release (plus release-less ones, keyed ''), no content. */
export function buildArtifactIndexQuery(db: string, orgId: string, projectId: number, release: string): string {
  return `SELECT release, name, debug_id, kind, size, uploaded_at FROM ${ident(db)}.${ARTIFACTS_TABLE} FINAL
WHERE ${scope(orgId, projectId)} AND release IN (${lit(release)}, '') ORDER BY release DESC, name LIMIT 2000`;
}

/** Artifacts matching debug ids (any release). */
export function buildArtifactsByDebugIdQuery(db: string, orgId: string, projectId: number, debugIds: string[]): string {
  const ids = debugIds.slice(0, 100).map((d) => lit(d.toLowerCase())).join(', ') || "''";
  return `SELECT release, name, debug_id, kind, size, uploaded_at FROM ${ident(db)}.${ARTIFACTS_TABLE} FINAL
WHERE ${scope(orgId, projectId)} AND debug_id IN (${ids}) LIMIT 200`;
}

export function buildArtifactContentQuery(db: string, orgId: string, projectId: number, release: string, name: string): string {
  return `SELECT content FROM ${ident(db)}.${ARTIFACTS_TABLE} FINAL
WHERE ${scope(orgId, projectId)} AND release = ${lit(release)} AND name = ${lit(name)} LIMIT 1`;
}

/* ----------------------------------------------------------------------------
 * Spikes (worker)
 * ------------------------------------------------------------------------- */

/**
 * Per-issue event counts in the last `windowMinutes` vs the preceding
 * `baselineHours` (excluding the window) — the spike detector's input.
 * Only issues with at least `minRecent` recent events come back.
 */
export function buildSpikeQuery(
  db: string,
  orgId: string,
  q: { windowMinutes?: number; baselineHours?: number; minRecent?: number } = {},
): string {
  const w = clampInt(q.windowMinutes, 10, 1, 120);
  const b = clampInt(q.baselineHours, 24, 1, 24 * 7);
  const min = clampInt(q.minRecent, 10, 1, 1_000_000);
  return `SELECT project_id, any(stack) AS stack, fingerprint, any(title) AS title,
  countIf(timestamp >= now64(3) - INTERVAL ${w} MINUTE) AS recent,
  countIf(timestamp < now64(3) - INTERVAL ${w} MINUTE) AS baseline
FROM ${ident(db)}.${EVENTS_TABLE}
WHERE org_id = ${lit(orgId)} AND timestamp >= now64(3) - INTERVAL ${b} HOUR - INTERVAL ${w} MINUTE
GROUP BY project_id, fingerprint
HAVING recent >= ${min}
ORDER BY recent DESC LIMIT 200`;
}
