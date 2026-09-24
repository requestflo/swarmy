/**
 * The Sentry-compatible ingest pipeline (`POST /api/<project>/envelope/` and
 * `/store/`). The HTTP shell lives in apps/api/src/errors-ingest.ts; this is
 * everything behind it:
 *
 *   decode (gzip/deflate/br/zstd) → parse → authenticate the DSN key →
 *   rate-limit (per project, 429 + X-Sentry-Rate-Limits) → normalise →
 *   symbolicate JS frames with uploaded source maps → group → issue state
 *   (new / regression) → insert events + issue rows into ClickHouse →
 *   alerts through `fireEvent`.
 *
 * Responses follow Relay: 200 `{"id": <event_id>}` for accepted (and for
 * item types swarmy doesn't store — sessions, spans, client reports — so SDKs
 * never retry them), 400 malformed, 401 no key, 403 wrong key/project,
 * 413 too large, 429 rate-limited.
 */
import type { DB } from '@swarmy/db';
import type { OrgContext } from '../../context';
import { fireEvent } from '../alerts-fire';
import {
  decodeBody,
  EnvelopeError,
  itemJson,
  MAX_EVENT_ITEM_BYTES,
  parseEnvelope,
  parseStoreBody,
  rateLimitHeader,
  resolveAuth,
} from './envelope';
import { culpritFrame, frameCulprit, messageTemplate, normalizeEvent, type NormalizedEvent } from './event';
import { computeGrouping } from './grouping';
import { decideTransition, issueResource } from './lifecycle';
import { keyMatches, lookupIngestProject, takeRateLimit, type IngestProject } from './projects';
import { buildIssueStateQuery, type IssueStateRow } from './query';
import type { OrgClickhouse } from '../observability.service';
import { clickhouseArtifacts, errorsStore, eventRow, issueRow, releaseRow, TABLES } from './store';
import { symbolicateEvent } from './symbolicate';

export interface IngestRequest {
  projectId: string;
  kind: 'envelope' | 'store';
  body: Uint8Array;
  contentEncoding?: string | null;
  authHeader?: string | null;
  query?: URLSearchParams;
}

export interface IngestResponse {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface IngestDeps {
  db: DB;
  /** Build a system OrgContext for the project's org (apps/api passes `systemContext`). */
  contextFor: (orgId: string) => OrgContext;
  /** Seams (tests): the org's store and the alert entry point. */
  store?: (ctx: OrgContext) => Promise<OrgClickhouse | null>;
  fire?: typeof fireEvent;
}

export type StoreSeams = Pick<IngestDeps, 'store' | 'fire'>;

const fail = (status: number, detail: string, headers?: Record<string, string>): IngestResponse => ({
  status,
  body: { detail },
  ...(headers ? { headers } : {}),
});

/** Releases already recorded this process (org|project|version), so ingest doesn't rewrite them. */
const knownReleases = new Set<string>();

export async function ingest(deps: IngestDeps, req: IngestRequest): Promise<IngestResponse> {
  if (!/^\d{1,10}$/.test(req.projectId)) return fail(400, 'invalid project id');
  const projectId = Number(req.projectId);

  let events: Record<string, unknown>[] = [];
  let envelopeHeader: Record<string, unknown> | undefined;
  let firstId = '';
  try {
    const body = decodeBody(req.body, req.contentEncoding);
    if (req.kind === 'store') {
      events = [parseStoreBody(body)];
    } else {
      const env = parseEnvelope(body);
      envelopeHeader = env.header;
      for (const item of env.items) {
        if (item.header.type !== 'event') continue; // sessions/spans/client reports: accepted, not stored
        if (item.payload.length > MAX_EVENT_ITEM_BYTES) continue;
        const ev = itemJson(item);
        if (ev) events.push(ev);
      }
    }
  } catch (e) {
    if (e instanceof EnvelopeError) return fail(e.message === 'body too large' ? 413 : 400, e.message);
    return fail(400, 'invalid body');
  }
  firstId = String(envelopeHeader?.event_id ?? events[0]?.event_id ?? '');

  const auth = resolveAuth({ authHeader: req.authHeader, query: req.query, envelopeHeader });
  if (!auth.publicKey) return fail(401, 'missing sentry_key');
  if (auth.dsnProjectId && auth.dsnProjectId !== req.projectId) return fail(403, 'DSN project mismatch');
  const project = await lookupIngestProject(deps.db, projectId);
  if (!project || !keyMatches(project, auth.publicKey)) return fail(403, 'unknown project or key');

  if (!events.length) return { status: 200, body: firstId ? { id: firstId } : {} };

  const retryAfter = takeRateLimit(project.projectId, project.rateLimitPerMinute, Date.now(), events.length);
  if (retryAfter > 0) {
    return fail(429, 'rate limited', {
      'Retry-After': String(retryAfter),
      'X-Sentry-Rate-Limits': rateLimitHeader(retryAfter),
    });
  }

  const ctx = deps.contextFor(project.orgId);
  const accepted = await storeEvents(ctx, project, events, envelopeHeader, deps);
  return { status: 200, body: { id: accepted[0] ?? firstId } };
}

/**
 * Normalise → symbolicate → group → write. Exported for tests and for a
 * future replay path. Returns the stored event ids. A disabled/unreachable
 * store drops the events (the SDK must not retry into a dead store) — the
 * dashboard surfaces the store state.
 */
export async function storeEvents(
  ctx: OrgContext,
  project: Pick<IngestProject, 'orgId' | 'projectId' | 'stack'>,
  events: Record<string, unknown>[],
  envelopeHeader?: Record<string, unknown>,
  seams: StoreSeams = {},
): Promise<string[]> {
  const ch = await (seams.store ?? errorsStore)(ctx).catch(() => null);
  const fire = seams.fire ?? fireEvent;
  if (!ch) return [];
  const now = Date.now();
  const artifacts = clickhouseArtifacts(ch, project.orgId, project.projectId);

  const prepared: { ev: NormalizedEvent; fingerprint: string }[] = [];
  for (const raw of events) {
    const ev = normalizeEvent(raw, { now, envelopeHeader });
    if (!ev.eventId) ev.eventId = crypto.randomUUID().replace(/-/g, '');
    await symbolicateEvent(ev, artifacts, `${project.orgId}|${project.projectId}`).catch(() => 0);
    if (!raw.culprit && !ev.transaction) ev.culprit = frameCulprit(culpritFrame(ev.exceptions));
    const grouping = computeGrouping(ev, messageTemplate(raw));
    ev.raw.swarmy = { grouping: { variant: grouping.variant, components: grouping.components } };
    prepared.push({ ev, fingerprint: grouping.hash });
  }

  const fps = [...new Set(prepared.map((p) => p.fingerprint))];
  const states = (await ch.query<IssueStateRow>(buildIssueStateQuery(ch.database, project.orgId, project.projectId, fps))) ?? [];
  const byFp = new Map(states.map((s) => [s.fingerprint, s]));

  const issueWrites: Record<string, unknown>[] = [];
  const alerts: { kind: 'new' | 'regression'; ev: NormalizedEvent; fingerprint: string }[] = [];
  for (const { ev, fingerprint } of prepared) {
    const state = byFp.get(fingerprint) ?? null;
    const t = decideTransition(state, { release: ev.release, timestamp: ev.timestamp });
    if (t.kind === 'none') continue;
    const base = {
      fingerprint,
      title: ev.title,
      culprit: ev.culprit,
      excType: ev.excType,
      level: ev.level,
      platform: ev.platform,
      status: 'unresolved' as const,
      resolvedInRelease: '',
      statusChangedAt: now,
      statusBy: t.kind === 'new' ? '' : 'system:regression',
      firstSeen: t.kind === 'new' ? ev.timestamp : Date.parse(`${state!.first_seen.replace(' ', 'T')}Z`) || ev.timestamp,
      firstRelease: t.kind === 'new' ? ev.release : state!.first_release,
      regressedAt: t.kind === 'regression' ? now : 0,
    };
    issueWrites.push(issueRow(project.orgId, project, base));
    // Later events in this batch see the reopened/new state.
    byFp.set(fingerprint, {
      fingerprint,
      title: base.title,
      culprit: base.culprit,
      exc_type: base.excType,
      level: base.level,
      platform: base.platform,
      status: 'unresolved',
      resolved_in_release: '',
      status_changed_at: '',
      status_by: base.statusBy,
      first_seen: '',
      first_release: base.firstRelease,
      regressed_at: '',
      version: 0,
    });
    alerts.push({ kind: t.kind, ev, fingerprint });
  }

  const releaseWrites: Record<string, unknown>[] = [];
  for (const { ev } of prepared) {
    if (!ev.release) continue;
    const key = `${project.orgId}|${project.projectId}|${ev.release}`;
    if (knownReleases.has(key)) continue;
    knownReleases.add(key);
    releaseWrites.push(
      releaseRow(project.orgId, project, {
        version: ev.release,
        commitSha: /^[0-9a-f]{7,40}$/i.test(ev.release) ? ev.release.toLowerCase() : '',
        environment: ev.environment,
        source: 'event',
        swarmyReleaseId: '',
        firstSeen: ev.timestamp,
        deployedAt: 0,
      }),
    );
  }

  try {
    await ch.insert(TABLES.EVENTS_TABLE, prepared.map(({ ev, fingerprint }) => eventRow(project.orgId, project, ev, fingerprint, now)));
    if (issueWrites.length) await ch.insert(TABLES.ISSUES_TABLE, issueWrites);
    if (releaseWrites.length) await ch.insert(TABLES.RELEASES_TABLE, releaseWrites);
  } catch {
    return [];
  }

  for (const a of alerts) {
    const resource = issueResource(project.stack, a.fingerprint);
    const where = a.ev.release ? ` in ${a.ev.release.slice(0, 12)}` : '';
    void fire(ctx, {
      signal: a.kind === 'new' ? 'error-new-issue' : 'error-regression',
      severity: a.kind === 'new' ? 'warning' : 'critical',
      resource,
      message:
        a.kind === 'new'
          ? `New error in ${project.stack}${where}: ${a.ev.title}`
          : `Regression in ${project.stack}${where}: ${a.ev.title} came back after it was resolved`,
    }).catch(() => undefined);
  }
  return prepared.map((p) => p.ev.eventId);
}
