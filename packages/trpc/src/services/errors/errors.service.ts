/**
 * Error tracking — the read/control layer behind `routers/errors.ts`.
 *
 *  - Opt-in per stack: the `swarmy.errors.enabled` service label (Docker
 *    truth), read back from the live inventory; `setStackEnabled` stamps it
 *    and ensures the stack's DSN (`ErrorProject`). A redeploy binds
 *    `SENTRY_DSN` (stack.service → `augmentSpecsForErrors`).
 *  - Issues, events, releases and artifacts are ClickHouse reads through
 *    the org-scoped builders in `query.ts`; issue status changes INSERT a
 *    newer ReplacingMergeTree row (never an UPDATE, never the controller DB).
 *  - Same fail-open `{status}` contract as observability reads: `disabled`
 *    when the store is off, `unreachable` when ClickHouse doesn't answer.
 */
import { buildInventory, type InvService } from '@swarmy/core';
import type { OrgContext } from '../../context';
import { badRequest, mapDispatchError, notFound } from '../../errors';
import { writeAudit } from '../audit.service';
import { resolveManagerNode } from '../dispatch.service';
import type { SentryBreadcrumb, SentryException } from './event';
import { ERRORS_ENABLED_LABEL } from './injection';
import { ensureProject, getProject, type ErrorProjectView } from './projects';
import {
  buildEventPayloadQuery,
  buildIssueDetailQuery,
  buildIssueEventsQuery,
  buildIssuesForTraceQuery,
  buildIssuesListQuery,
  buildIssueStateQuery,
  buildIssueTagsQuery,
  buildIssueTrendQuery,
  buildReleaseQuery,
  buildReleasesQuery,
  type EventListRow,
  type EventPayloadRow,
  type IssueListRow,
  type IssueStateRow,
  type IssueStatus,
  type IssueTrendRow,
  type ReleaseRow,
  type TagRow,
} from './query';
import { artifactRow, errorsStore, invalidateArtifactIndex, issueRow, releaseRow, TABLES } from './store';
import { clearSourceMapCache } from './symbolicate';

export type ReadStatus = 'ok' | 'disabled' | 'unreachable' | 'no_project';

/* ----------------------------------------------------------------------------
 * Views
 * ------------------------------------------------------------------------- */

export interface IssueView {
  fingerprint: string;
  title: string;
  culprit: string;
  type: string;
  level: string;
  platform: string;
  status: IssueStatus;
  resolvedInRelease: string | null;
  statusChangedAt: string | null;
  firstSeen: string | null;
  firstRelease: string | null;
  regressedAt: string | null;
  lastSeen: string | null;
  lastRelease: string | null;
  count: number;
  users: number;
  count24h: number;
  /** 24 hourly buckets, oldest first. */
  trend: number[];
}

export interface EventSummaryView {
  eventId: string;
  timestamp: string;
  release: string;
  environment: string;
  serverName: string;
  user: string;
  traceId: string | null;
  spanId: string | null;
  replayId: string | null;
}

export interface FrameView {
  filename: string;
  function: string | null;
  lineno: number | null;
  colno: number | null;
  inApp: boolean;
  module: string | null;
  preContext: string[];
  contextLine: string | null;
  postContext: string[];
  /** The minified position when a source map resolved this frame. */
  minified: { filename: string | null; function: string | null; lineno: number | null; colno: number | null } | null;
  sourcemap: string | null;
}

export interface ExceptionView {
  type: string;
  value: string;
  mechanism: string | null;
  handled: boolean | null;
  /** Crash frame LAST (Sentry order). */
  frames: FrameView[];
}

export interface EventDetailView extends EventSummaryView {
  title: string;
  level: string;
  platform: string;
  message: string;
  exceptions: ExceptionView[];
  breadcrumbs: { timestamp: string | null; category: string; level: string; message: string; type: string; data: Record<string, unknown> | null }[];
  tags: Record<string, string>;
  contexts: Record<string, unknown>;
  request: { method: string | null; url: string | null } | null;
  userDetail: Record<string, string>;
  sdk: string;
  grouping: { variant: string; components: string[] } | null;
}

export interface ReleaseView {
  version: string;
  commitSha: string | null;
  environment: string;
  source: string;
  swarmyReleaseId: string | null;
  firstSeen: string | null;
  deployedAt: string | null;
  newIssues: number;
  events: number;
}

export interface IssueDetailView {
  status: ReadStatus;
  issue: IssueView | null;
  event: EventDetailView | null;
  events: EventSummaryView[];
  tags: { key: string; values: { value: string; count: number }[] }[];
  introducedIn: ReleaseView | null;
}

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0) || 0);
/** ClickHouse epoch-zero defaults read as "unset". */
function ts(v: unknown): string | null {
  if (typeof v !== 'string' || !v || v.startsWith('1970-01-01')) return null;
  const iso = `${v.replace(' ', 'T')}${v.endsWith('Z') ? '' : 'Z'}`;
  return Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString() : null;
}
const nz = (s: string | undefined | null): string | null => (s ? s : null);

function issueView(r: IssueListRow, trend: number[] = []): IssueView {
  return {
    fingerprint: r.fingerprint,
    title: r.title,
    culprit: r.culprit,
    type: r.exc_type,
    level: r.level,
    platform: r.platform,
    status: r.status,
    resolvedInRelease: nz(r.resolved_in_release),
    statusChangedAt: ts(r.status_changed_at),
    firstSeen: ts(r.first_seen),
    firstRelease: nz(r.first_release),
    regressedAt: ts(r.regressed_at),
    lastSeen: ts(r.last_seen),
    lastRelease: nz(r.last_release),
    count: num(r.count),
    users: num(r.users),
    count24h: num(r.count_24h),
    trend,
  };
}

function eventSummary(r: EventListRow): EventSummaryView {
  return {
    eventId: r.event_id,
    timestamp: ts(r.timestamp) ?? new Date(0).toISOString(),
    release: r.release,
    environment: r.environment,
    serverName: r.server_name,
    user: r.user_key.replace(/^(id|email|u|ip):/, ''),
    traceId: nz(r.trace_id),
    spanId: nz(r.span_id),
    replayId: nz(r.replay_id),
  };
}

function releaseView(r: ReleaseRow): ReleaseView {
  return {
    version: r.version,
    commitSha: nz(r.commit_sha),
    environment: r.environment,
    source: r.source,
    swarmyReleaseId: nz(r.swarmy_release_id),
    firstSeen: ts(r.first_seen),
    deployedAt: ts(r.deployed_at),
    newIssues: num(r.new_issues),
    events: num(r.events),
  };
}

const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const strOr = (v: unknown, d = ''): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : d);

/** Parse a stored payload into the detail view (defensive: payloads are SDK-shaped). */
export function eventDetail(row: EventPayloadRow): EventDetailView {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    raw = {};
  }
  const exc = asObj(raw.exception).values;
  const exceptions: ExceptionView[] = (Array.isArray(exc) ? (exc as SentryException[]) : []).map((e) => ({
    type: strOr(e.type),
    value: strOr(e.value),
    mechanism: e.mechanism?.type ?? null,
    handled: typeof e.mechanism?.handled === 'boolean' ? e.mechanism.handled : null,
    frames: (e.stacktrace?.frames ?? []).slice(-200).map((f) => ({
      filename: strOr(f.filename || f.abs_path, '<unknown>'),
      function: f.function ?? null,
      lineno: f.lineno ?? null,
      colno: f.colno ?? null,
      inApp: f.in_app === true,
      module: f.module ?? null,
      preContext: f.pre_context ?? [],
      contextLine: f.context_line ?? null,
      postContext: f.post_context ?? [],
      minified: f.data?.minified ?? null,
      sourcemap: f.data?.sourcemap ?? null,
    })),
  }));
  const crumbsRaw = Array.isArray(raw.breadcrumbs) ? raw.breadcrumbs : asObj(raw.breadcrumbs).values;
  const breadcrumbs = (Array.isArray(crumbsRaw) ? (crumbsRaw as SentryBreadcrumb[]) : []).slice(-100).map((b) => ({
    timestamp:
      typeof b.timestamp === 'number' ? new Date(b.timestamp * 1000).toISOString() : typeof b.timestamp === 'string' ? b.timestamp : null,
    category: strOr(b.category),
    level: strOr(b.level, 'info'),
    message: strOr(b.message),
    type: strOr(b.type, 'default'),
    data: b.data && typeof b.data === 'object' ? b.data : null,
  }));
  const tagsRaw = raw.tags;
  const tags: Record<string, string> = {};
  if (Array.isArray(tagsRaw)) for (const p of tagsRaw) Array.isArray(p) && (tags[String(p[0])] = String(p[1]));
  else for (const [k, v] of Object.entries(asObj(tagsRaw))) tags[k] = strOr(v, JSON.stringify(v));
  const req = asObj(raw.request);
  const user = asObj(raw.user);
  const userDetail: Record<string, string> = {};
  for (const k of ['id', 'email', 'username', 'ip_address']) if (user[k]) userDetail[k] = strOr(user[k]);
  const sdk = asObj(raw.sdk);
  const grouping = asObj(asObj(raw.swarmy).grouping);
  const le = asObj(raw.logentry);
  return {
    ...eventSummary(row),
    title: row.title,
    level: row.level,
    platform: strOr(raw.platform, 'other'),
    message: strOr(le.formatted) || strOr(le.message) || strOr(raw.message),
    exceptions,
    breadcrumbs,
    tags,
    contexts: asObj(raw.contexts),
    request: Object.keys(req).length ? { method: strOr(req.method) || null, url: strOr(req.url) || null } : null,
    userDetail,
    sdk: [strOr(sdk.name), strOr(sdk.version)].filter(Boolean).join(' '),
    grouping: Array.isArray(grouping.components)
      ? { variant: strOr(grouping.variant), components: grouping.components.map((c) => strOr(c)) }
      : null,
  };
}

/* ----------------------------------------------------------------------------
 * Opt-in (Docker label) + project
 * ------------------------------------------------------------------------- */

function liveStackServices(ctx: OrgContext, stack: string): InvService[] {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  return buildInventory(services, containers).services.filter((s) => s.stack === stack);
}

/** A stack has error tracking on when any live service carries `swarmy.errors.enabled=true`. */
export function stackErrorsEnabled(ctx: OrgContext, stack: string): boolean {
  return liveStackServices(ctx, stack).some((s) => s.labels[ERRORS_ENABLED_LABEL] === 'true');
}

/** Whether each live service of the stack already runs with SENTRY_DSN bound. */
function servicesNeedingRedeploy(ctx: OrgContext, stack: string): string[] {
  return liveStackServices(ctx, stack)
    .filter((s) => s.labels[ERRORS_ENABLED_LABEL] === 'true' && !(s.env ?? []).some((e) => e.startsWith('SENTRY_DSN=')))
    .map((s) => s.name);
}

export interface StackErrorsStatus {
  enabled: boolean;
  storeEnabled: boolean;
  project: ErrorProjectView | null;
  /** Opted-in services whose running spec predates the opt-in (redeploy to bind SENTRY_DSN). */
  pendingRedeploy: string[];
}

export async function stackStatus(ctx: OrgContext, stack: string): Promise<StackErrorsStatus> {
  const [project, store] = await Promise.all([getProject(ctx, stack), errorsStore(ctx).catch(() => null)]);
  return {
    enabled: stackErrorsEnabled(ctx, stack),
    storeEnabled: !!store,
    project,
    pendingRedeploy: servicesNeedingRedeploy(ctx, stack),
  };
}

/**
 * Flip the per-stack opt-in: stamp/clear the label on every live service and
 * ensure the DSN. The DSN reaches the containers on the next deploy.
 */
export async function setStackEnabled(ctx: OrgContext, input: { stack: string; enabled: boolean }): Promise<StackErrorsStatus> {
  const services = liveStackServices(ctx, input.stack);
  if (!services.length) throw notFound('stack', input.stack);
  if (input.enabled) await ensureProject(ctx, input.stack);
  const node = await resolveManagerNode(ctx);
  try {
    for (const svc of services) {
      await ctx.hub.dispatch(node.id, 'service.updateLabels', {
        service: svc.name,
        add: input.enabled ? { [ERRORS_ENABLED_LABEL]: 'true' } : {},
        removeKeys: input.enabled ? [] : [ERRORS_ENABLED_LABEL],
      });
    }
  } catch (e) {
    throw mapDispatchError(e);
  }
  await writeAudit(ctx, {
    action: input.enabled ? 'errors.stack.enable' : 'errors.stack.disable',
    targetType: 'stack',
    targetId: input.stack,
  });
  return stackStatus(ctx, input.stack);
}

/* ----------------------------------------------------------------------------
 * Reads
 * ------------------------------------------------------------------------- */

export interface IssuesListResult {
  status: ReadStatus;
  issues: IssueView[];
}

function trendFor(rows: IssueTrendRow[], fingerprint: string, now = Date.now()): number[] {
  const hour = 3_600_000;
  const start = Math.floor(now / hour) * hour - 23 * hour;
  const out = new Array<number>(24).fill(0);
  for (const r of rows) {
    if (r.fingerprint !== fingerprint) continue;
    const t = Date.parse(`${r.bucket.replace(' ', 'T')}Z`);
    const i = Math.round((t - start) / hour);
    if (i >= 0 && i < 24) out[i] = num(r.c);
  }
  return out;
}

export async function listIssues(
  ctx: OrgContext,
  q: { stack: string; status?: IssueStatus | 'all'; query?: string; release?: string; sort?: 'last_seen' | 'first_seen' | 'count' | 'users'; limit?: number },
): Promise<IssuesListResult> {
  const project = await getProject(ctx, q.stack);
  if (!project) return { status: 'no_project', issues: [] };
  const ch = await errorsStore(ctx).catch(() => null);
  if (!ch) return { status: 'disabled', issues: [] };
  const rows = await ch.query<IssueListRow>(
    buildIssuesListQuery(ch.database, ctx.activeOrgId, { projectId: project.projectId, status: q.status, query: q.query, release: q.release, sort: q.sort, limit: q.limit }),
  );
  if (rows === null) return { status: 'unreachable', issues: [] };
  const trend = rows.length
    ? ((await ch.query<IssueTrendRow>(buildIssueTrendQuery(ch.database, ctx.activeOrgId, project.projectId, rows.map((r) => r.fingerprint)))) ?? [])
    : [];
  return { status: 'ok', issues: rows.map((r) => issueView(r, trendFor(trend, r.fingerprint))) };
}

export async function issueDetail(
  ctx: OrgContext,
  q: { stack: string; fingerprint: string; eventId?: string },
): Promise<IssueDetailView> {
  const empty: IssueDetailView = { status: 'ok', issue: null, event: null, events: [], tags: [], introducedIn: null };
  const project = await getProject(ctx, q.stack);
  if (!project) return { ...empty, status: 'no_project' };
  const ch = await errorsStore(ctx).catch(() => null);
  if (!ch) return { ...empty, status: 'disabled' };
  const db = ch.database;
  const org = ctx.activeOrgId;
  const pid = project.projectId;
  const [issueRows, payloadRows, eventRows, tagRows] = await Promise.all([
    ch.query<IssueListRow>(buildIssueDetailQuery(db, org, pid, q.fingerprint)),
    ch.query<EventPayloadRow>(buildEventPayloadQuery(db, org, pid, q.fingerprint, q.eventId)),
    ch.query<EventListRow>(buildIssueEventsQuery(db, org, pid, q.fingerprint, 25)),
    ch.query<TagRow>(buildIssueTagsQuery(db, org, pid, q.fingerprint)),
  ]);
  if (issueRows === null) return { ...empty, status: 'unreachable' };
  const row = issueRows[0];
  if (!row) return empty;
  const tags = new Map<string, { value: string; count: number }[]>();
  for (const t of tagRows ?? []) {
    const list = tags.get(t.k) ?? [];
    list.push({ value: t.v, count: num(t.c) });
    tags.set(t.k, list);
  }
  let introducedIn: ReleaseView | null = null;
  if (row.first_release) {
    const rel = await ch.query<ReleaseRow>(buildReleaseQuery(db, org, pid, row.first_release));
    introducedIn = rel?.[0] ? releaseView(rel[0]) : { version: row.first_release, commitSha: null, environment: '', source: 'event', swarmyReleaseId: null, firstSeen: null, deployedAt: null, newIssues: 0, events: 0 };
  }
  return {
    status: 'ok',
    issue: issueView(row),
    event: payloadRows?.[0] ? eventDetail(payloadRows[0]) : null,
    events: (eventRows ?? []).map(eventSummary),
    tags: [...tags.entries()].map(([key, values]) => ({ key, values })),
    introducedIn,
  };
}

export async function listReleases(ctx: OrgContext, q: { stack: string; limit?: number }): Promise<{ status: ReadStatus; releases: ReleaseView[] }> {
  const project = await getProject(ctx, q.stack);
  if (!project) return { status: 'no_project', releases: [] };
  const ch = await errorsStore(ctx).catch(() => null);
  if (!ch) return { status: 'disabled', releases: [] };
  const rows = await ch.query<ReleaseRow>(buildReleasesQuery(ch.database, ctx.activeOrgId, project.projectId, q.limit));
  if (rows === null) return { status: 'unreachable', releases: [] };
  return { status: 'ok', releases: rows.map(releaseView) };
}

/** Issues seen inside one trace (for the trace waterfall's "errors" strip). */
export async function issuesForTrace(
  ctx: OrgContext,
  traceId: string,
): Promise<{ status: ReadStatus; issues: { stack: string; fingerprint: string; title: string; count: number }[] }> {
  const ch = await errorsStore(ctx).catch(() => null);
  if (!ch) return { status: 'disabled', issues: [] };
  const rows = await ch.query<{ stack: string; fingerprint: string; title: string; c: string | number }>(
    buildIssuesForTraceQuery(ch.database, ctx.activeOrgId, traceId),
  );
  if (rows === null) return { status: 'unreachable', issues: [] };
  return { status: 'ok', issues: rows.map((r) => ({ stack: r.stack, fingerprint: r.fingerprint, title: r.title, count: num(r.c) })) };
}

/* ----------------------------------------------------------------------------
 * Mutations
 * ------------------------------------------------------------------------- */

/**
 * Resolve / ignore / reopen / resolve-in-next-release. "Next release" pins
 * the release the issue was LAST seen in: events from it are expected
 * stragglers, an event from any other release reopens the issue.
 */
export async function setIssueStatus(
  ctx: OrgContext,
  input: { stack: string; fingerprint: string; status: IssueStatus },
): Promise<IssueView> {
  const project = await getProject(ctx, input.stack);
  if (!project) throw notFound('error project', input.stack);
  const ch = await errorsStore(ctx);
  if (!ch) throw badRequest('error tracking needs the observability store — turn Observability on first');
  const rows = await ch.query<IssueListRow>(buildIssueDetailQuery(ch.database, ctx.activeOrgId, project.projectId, input.fingerprint));
  const cur = rows?.[0];
  if (!cur) throw notFound('issue', input.fingerprint);
  const resolvedInRelease = input.status === 'resolved_next_release' ? cur.last_release || cur.first_release : '';
  if (input.status === 'resolved_next_release' && !resolvedInRelease) {
    throw badRequest('this issue has no release yet — set SENTRY_RELEASE (swarmy does on git deploys) or resolve it now');
  }
  const now = Date.now();
  const parse = (v: string) => Date.parse(`${v.replace(' ', 'T')}Z`) || 0;
  await ch.insert(TABLES.ISSUES_TABLE, [
    issueRow(ctx.activeOrgId, project, {
      fingerprint: cur.fingerprint,
      title: cur.title,
      culprit: cur.culprit,
      excType: cur.exc_type,
      level: cur.level,
      platform: cur.platform,
      status: input.status,
      resolvedInRelease,
      statusChangedAt: now,
      statusBy: ctx.user?.id ?? 'system',
      firstSeen: parse(cur.first_seen),
      firstRelease: cur.first_release,
      regressedAt: input.status === 'unresolved' ? parse(cur.regressed_at) : parse(cur.regressed_at),
    }),
  ]);
  await writeAudit(ctx, {
    action: `errors.issue.${input.status}`,
    targetType: 'errorIssue',
    targetId: cur.fingerprint,
    metadata: { stack: input.stack, title: cur.title.slice(0, 200), ...(resolvedInRelease ? { release: resolvedInRelease } : {}) },
  });
  const state = await ch.query<IssueStateRow>(buildIssueStateQuery(ch.database, ctx.activeOrgId, project.projectId, [cur.fingerprint]));
  return issueView({ ...cur, ...(state?.[0] ?? {}), status: input.status, resolved_in_release: resolvedInRelease } as IssueListRow);
}

/**
 * Record a deploy as a release (git sha from the build), so an issue's
 * "introduced in" links to the deploy that shipped it. Called from the deploy
 * path when the stack has error tracking on; a no-op without a project/store.
 */
export async function recordDeployRelease(
  ctx: OrgContext,
  input: { stack: string; version: string; commitSha?: string; environment?: string; swarmyReleaseId?: string },
): Promise<void> {
  if (!input.version) return;
  const project = await getProject(ctx, input.stack);
  if (!project) return;
  const ch = await errorsStore(ctx).catch(() => null);
  if (!ch) return;
  const now = Date.now();
  await ch.insert(TABLES.RELEASES_TABLE, [
    releaseRow(ctx.activeOrgId, project, {
      version: input.version,
      commitSha: input.commitSha ?? (/^[0-9a-f]{7,40}$/i.test(input.version) ? input.version.toLowerCase() : ''),
      environment: input.environment ?? 'production',
      source: 'deploy',
      swarmyReleaseId: input.swarmyReleaseId ?? '',
      firstSeen: now,
      deployedAt: now,
    }),
  ]);
}

export const MAX_ARTIFACT_BYTES = 15 * 1024 * 1024;

/**
 * Store source maps / minified bundles for a release (`swarmy sourcemaps
 * upload`, the CI build step, or the HTTP upload endpoint). `release: ''`
 * stores release-less artifacts (matched for every release — debug ids make
 * that safe). Names follow Sentry's convention: `~/static/js/app.js(.map)`.
 */
export async function uploadArtifacts(
  ctx: OrgContext,
  input: { stack: string; release: string; files: { name: string; content: string }[] },
): Promise<{ stored: { name: string; kind: string; debugId: string | null; size: number }[] }> {
  if (!input.files.length) throw badRequest('no files');
  const project = await ensureProject(ctx, input.stack);
  const ch = await errorsStore(ctx);
  if (!ch) throw badRequest('error tracking needs the observability store — turn Observability on first');
  const rows = input.files.map((f) => {
    if (!f.name.trim()) throw badRequest('every file needs a name (e.g. ~/static/js/app.js.map)');
    if (Buffer.byteLength(f.content) > MAX_ARTIFACT_BYTES) throw badRequest(`${f.name} is larger than 15 MB`);
    return artifactRow(ctx.activeOrgId, project.projectId, { release: input.release, name: f.name.trim(), content: f.content });
  });
  await ch.insert(TABLES.ARTIFACTS_TABLE, rows);
  invalidateArtifactIndex(ctx.activeOrgId, project.projectId);
  clearSourceMapCache();
  await writeAudit(ctx, {
    action: 'errors.artifacts.upload',
    targetType: 'stack',
    targetId: input.stack,
    metadata: { release: input.release, files: rows.map((r) => r.name).slice(0, 50) },
  });
  return {
    stored: rows.map((r) => ({ name: String(r.name), kind: String(r.kind), debugId: (r.debug_id as string) || null, size: Number(r.size) })),
  };
}
