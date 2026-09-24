/**
 * Error tracking ↔ the observability ClickHouse store (IO).
 *
 * Reaches the store through `orgClickhouse` (the org's DSN, same credentials
 * as the trace/log readers). Tables are ensured lazily — once per process per
 * (org, retention) — with the idempotent DDL from `schema.ts`, the same
 * DDL-over-HTTP path the suite replays on deploy. Nothing here deletes.
 */
import type { OrgContext } from '../../context';
import { orgClickhouse, type OrgClickhouse } from '../observability.service';
import type { NormalizedEvent } from './event';
import { ARTIFACTS_TABLE, EVENTS_TABLE, ISSUES_TABLE, RELEASES_TABLE, renderErrorsSchema } from './schema';
import {
  buildArtifactContentQuery,
  buildArtifactIndexQuery,
  buildArtifactsByDebugIdQuery,
  chTime,
  type ArtifactIndexRow,
  type IssueStatus,
} from './query';
import type { ArtifactEntry, ArtifactSource } from './symbolicate';
import { normalizeDebugId } from './sourcemap';

export { normalizeDebugId };

const ensured = new Map<string, string>();

/** The org's store with the error tables ensured, or null when the suite is off. */
export async function errorsStore(ctx: OrgContext): Promise<OrgClickhouse | null> {
  const ch = await orgClickhouse(ctx);
  if (!ch) return null;
  const sig = `${ch.database}|${ch.retentionDays}`;
  if (ensured.get(ctx.activeOrgId) !== sig) {
    for (const stmt of renderErrorsSchema({ database: ch.database, retentionDays: ch.retentionDays })) {
      await ch.exec(stmt);
    }
    ensured.set(ctx.activeOrgId, sig);
  }
  return ch;
}

/** Forget the ensured marker (store redeployed / tests). */
export function forgetErrorsSchema(orgId?: string): void {
  if (orgId) ensured.delete(orgId);
  else ensured.clear();
}

/* ----------------------------------------------------------------------------
 * Row mappers (JSONEachRow bodies)
 * ------------------------------------------------------------------------- */

export function eventRow(
  orgId: string,
  project: { projectId: number; stack: string },
  e: NormalizedEvent,
  fingerprint: string,
  receivedAt: number,
): Record<string, unknown> {
  let payload = JSON.stringify(e.raw);
  if (payload.length > 900_000) {
    // Keep the stack + context; drop the bulky optional parts.
    const slim = { ...e.raw, extra: '[trimmed]', breadcrumbs: undefined, request: undefined };
    payload = JSON.stringify(slim).slice(0, 900_000);
  }
  return {
    org_id: orgId,
    project_id: project.projectId,
    stack: project.stack,
    event_id: e.eventId,
    fingerprint,
    timestamp: chTime(e.timestamp),
    received_at: chTime(receivedAt),
    level: e.level,
    platform: e.platform,
    exc_type: e.excType,
    exc_value: e.excValue,
    title: e.title,
    culprit: e.culprit,
    transaction: e.transaction,
    release: e.release,
    environment: e.environment,
    server_name: e.serverName,
    user_key: e.userKey,
    user_id: e.userId,
    user_email: e.userEmail,
    user_ip: e.userIp,
    trace_id: e.traceId,
    span_id: e.spanId,
    replay_id: e.replayId,
    sdk_name: e.sdkName,
    sdk_version: e.sdkVersion,
    handled: e.handled ? 1 : 0,
    tags: e.tags,
    payload,
  };
}

export interface IssueWrite {
  fingerprint: string;
  title: string;
  culprit: string;
  excType: string;
  level: string;
  platform: string;
  status: IssueStatus;
  resolvedInRelease: string;
  statusChangedAt: number;
  statusBy: string;
  firstSeen: number;
  firstRelease: string;
  regressedAt: number;
}

export function issueRow(orgId: string, project: { projectId: number; stack: string }, i: IssueWrite): Record<string, unknown> {
  return {
    org_id: orgId,
    project_id: project.projectId,
    stack: project.stack,
    fingerprint: i.fingerprint,
    title: i.title,
    culprit: i.culprit,
    exc_type: i.excType,
    level: i.level,
    platform: i.platform,
    status: i.status,
    resolved_in_release: i.resolvedInRelease,
    status_changed_at: chTime(i.statusChangedAt),
    status_by: i.statusBy,
    first_seen: chTime(i.firstSeen),
    first_release: i.firstRelease,
    regressed_at: chTime(i.regressedAt),
    // Monotonic version for ReplacingMergeTree: newest write wins.
    version: Date.now() * 1000 + Math.floor(Math.random() * 1000),
  };
}

export interface ReleaseWrite {
  version: string;
  commitSha: string;
  environment: string;
  source: 'deploy' | 'event' | 'upload';
  swarmyReleaseId: string;
  firstSeen: number;
  deployedAt: number;
}

export function releaseRow(orgId: string, project: { projectId: number; stack: string }, r: ReleaseWrite): Record<string, unknown> {
  return {
    org_id: orgId,
    project_id: project.projectId,
    stack: project.stack,
    version: r.version,
    commit_sha: r.commitSha,
    environment: r.environment,
    source: r.source,
    swarmy_release_id: r.swarmyReleaseId,
    first_seen: chTime(r.firstSeen),
    deployed_at: chTime(r.deployedAt),
    // A release seen only on events must never replace one a deploy recorded
    // (ReplacingMergeTree keeps the highest `updated`).
    updated: r.source === 'event' ? 1 : Date.now(),
  };
}

export const TABLES = { EVENTS_TABLE, ISSUES_TABLE, RELEASES_TABLE, ARTIFACTS_TABLE };

/* ----------------------------------------------------------------------------
 * Artifacts
 * ------------------------------------------------------------------------- */

const INDEX_TTL_MS = 60_000;
const indexCache = new Map<string, { at: number; rows: ArtifactEntry[] }>();

export function invalidateArtifactIndex(orgId: string, projectId: number): void {
  for (const k of indexCache.keys()) if (k.startsWith(`${orgId}|${projectId}|`)) indexCache.delete(k);
}

function toEntry(r: ArtifactIndexRow): ArtifactEntry {
  return { release: r.release, name: r.name, debugId: r.debug_id, kind: r.kind };
}

/** A ClickHouse-backed {@link ArtifactSource} for one project. */
export function clickhouseArtifacts(ch: OrgClickhouse, orgId: string, projectId: number): ArtifactSource {
  return {
    async index(release) {
      const key = `${orgId}|${projectId}|${release}`;
      const hit = indexCache.get(key);
      if (hit && Date.now() - hit.at < INDEX_TTL_MS) return hit.rows;
      const rows = (await ch.query<ArtifactIndexRow>(buildArtifactIndexQuery(ch.database, orgId, projectId, release))) ?? [];
      const entries = rows.map(toEntry);
      indexCache.set(key, { at: Date.now(), rows: entries });
      if (indexCache.size > 500) indexCache.delete(indexCache.keys().next().value!);
      return entries;
    },
    async byDebugIds(ids) {
      const rows = (await ch.query<ArtifactIndexRow>(buildArtifactsByDebugIdQuery(ch.database, orgId, projectId, ids))) ?? [];
      return rows.map(toEntry);
    },
    async load(release, name) {
      const rows = await ch.query<{ content: string }>(buildArtifactContentQuery(ch.database, orgId, projectId, release, name));
      return rows?.[0]?.content ?? null;
    },
  };
}

/** Classify an uploaded file by name/content. */
export function artifactKind(name: string, content: string): 'sourcemap' | 'minified' {
  if (/\.map$/i.test(name.replace(/[?#].*$/, ''))) return 'sourcemap';
  const head = content.trimStart().slice(0, 200);
  if (head.startsWith('{') && /"mappings"\s*:/.test(content.slice(0, 20_000)) && /"version"\s*:\s*3/.test(content.slice(0, 20_000))) {
    return 'sourcemap';
  }
  return 'minified';
}

/** Debug id carried by an artifact: a map's `debugId`/`debug_id`, or a bundle's `//# debugId=` comment. */
export function artifactDebugId(kind: string, content: string): string {
  if (kind === 'sourcemap') {
    const m = /"debug_?[iI]d"\s*:\s*"([0-9a-fA-F-]{32,36})"/.exec(content.slice(0, 50_000)) ?? /"debug_?[iI]d"\s*:\s*"([0-9a-fA-F-]{32,36})"/.exec(content.slice(-2000));
    return m ? normalizeDebugId(m[1]!) : '';
  }
  const m = /\/\/# debugId=([0-9a-fA-F-]{32,36})/.exec(content.slice(-4000));
  return m ? normalizeDebugId(m[1]!) : '';
}

export function artifactRow(
  orgId: string,
  projectId: number,
  a: { release: string; name: string; content: string },
): Record<string, unknown> {
  const kind = artifactKind(a.name, a.content);
  return {
    org_id: orgId,
    project_id: projectId,
    release: a.release,
    name: a.name,
    debug_id: artifactDebugId(kind, a.content),
    kind,
    size: Buffer.byteLength(a.content),
    content: a.content,
    uploaded_at: chTime(Date.now()),
  };
}
