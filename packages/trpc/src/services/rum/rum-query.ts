/**
 * RUM reads (analytics dashboard, replay list/player) and GDPR deletes. All
 * SQL comes from the pure @swarmy/rum builders (org + app scoped).
 */
import { gunzipSync } from 'node:zlib';
import {
  buildBreakdownQuery,
  buildDeleteSessionStatements,
  buildDeleteUserStatements,
  buildFootprintQuery,
  buildLiveQuery,
  buildOverviewQuery,
  buildReplayChunksQuery,
  buildReplayErrorsQuery,
  buildReplayListQuery,
  buildReplayLogsQuery,
  buildReplayRequestsQuery,
  buildSeriesQuery,
  buildUserSessionsQuery,
  buildUsersQuery,
  deletePrefix,
  replaySessionPrefix,
  SESSION_ID_RE,
  type Breakdown,
  type ClickhouseClient,
} from '@swarmy/rum';
import type { OrgContext } from '../../context';
import { writeAudit } from '../audit.service';
import { rumBlobStore, rumClickhouse } from './rum-store';

export type RumStatus = 'ok' | 'disabled' | 'unreachable';

async function ch(ctx: OrgContext): Promise<ClickhouseClient | null> {
  return rumClickhouse(ctx, ctx.activeOrgId).catch(() => null);
}

async function rows<T>(client: ClickhouseClient, sql: string): Promise<T[]> {
  return client.json<T>(sql);
}

const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0) || 0);

// ── analytics ──────────────────────────────────────────────────────────

export interface AnalyticsView {
  status: RumStatus;
  days: number;
  kpis: { visits: number; pageviews: number; bounceRate: number; medianVisitSeconds: number; signedIn: number };
  live: { visitors: number; pageviews: number };
  series: Array<{ day: string; visitors: number; pageviews: number }>;
  pages: Array<{ key: string; visitors: number; pageviews: number }>;
  referrers: Array<{ key: string; visitors: number; pageviews: number }>;
  countries: Array<{ key: string; visitors: number; pageviews: number }>;
  devices: Array<{ key: string; visitors: number; pageviews: number }>;
  browsers: Array<{ key: string; visitors: number; pageviews: number }>;
  sources: Array<{ key: string; visitors: number; pageviews: number }>;
  users: Array<{ userId: string; pageviews: number; sessions: number; lastSeen: string; country: string; lastSession: string }>;
}

const EMPTY_KPIS = { visits: 0, pageviews: 0, bounceRate: 0, medianVisitSeconds: 0, signedIn: 0 };

export async function analytics(ctx: OrgContext, input: { stack: string; days?: number }): Promise<AnalyticsView> {
  const days = Math.min(90, Math.max(1, Math.floor(input.days ?? 7)));
  const empty: AnalyticsView = {
    status: 'disabled',
    days,
    kpis: EMPTY_KPIS,
    live: { visitors: 0, pageviews: 0 },
    series: [],
    pages: [],
    referrers: [],
    countries: [],
    devices: [],
    browsers: [],
    sources: [],
    users: [],
  };
  const client = await ch(ctx);
  if (!client) return empty;
  const o = ctx.activeOrgId;
  const a = input.stack;
  const q = { days };
  const bd = (dim: Breakdown, limit = 10) =>
    rows<{ key: string; visitors: unknown; pageviews: unknown }>(client, buildBreakdownQuery(o, a, dim, { ...q, limit })).then((r) =>
      r.map((x) => ({ key: x.key, visitors: num(x.visitors), pageviews: num(x.pageviews) })),
    );
  try {
    const [kpi, live, series, pages, referrers, countries, devices, browsers, sources, users] = await Promise.all([
      rows<Record<string, unknown>>(client, buildOverviewQuery(o, a, q)),
      rows<Record<string, unknown>>(client, buildLiveQuery(o, a)),
      rows<{ day: string; visitors: unknown; pageviews: unknown }>(client, buildSeriesQuery(o, a, q)),
      bd('path'),
      bd('referrer_host'),
      bd('country', 20),
      bd('device', 5),
      bd('browser', 8),
      bd('utm_source'),
      rows<Record<string, unknown>>(client, buildUsersQuery(o, a, { ...q, limit: 20 })),
    ]);
    const k = kpi[0] ?? {};
    return {
      status: 'ok',
      days,
      kpis: {
        visits: num(k.visits),
        pageviews: num(k.pageviews),
        bounceRate: num(k.bounce_rate),
        medianVisitSeconds: num(k.median_visit_s),
        signedIn: num(k.signed_in),
      },
      live: { visitors: num(live[0]?.visitors), pageviews: num(live[0]?.pageviews) },
      series: series.map((s) => ({ day: s.day, visitors: num(s.visitors), pageviews: num(s.pageviews) })),
      pages,
      referrers,
      countries,
      devices,
      browsers,
      sources,
      users: users.map((u) => ({
        userId: String(u.user_id),
        pageviews: num(u.pageviews),
        sessions: num(u.sessions),
        lastSeen: String(u.last_seen),
        country: String(u.country ?? ''),
        lastSession: String(u.last_session ?? ''),
      })),
    };
  } catch {
    return { ...empty, status: 'unreachable' };
  }
}

// ── replays ────────────────────────────────────────────────────────────

export interface ReplaySessionView {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  events: number;
  bytes: number;
  clicks: number;
  errors: number;
  requests: number;
  chunks: number;
  firstPath: string;
  userId: string;
  country: string;
  device: string;
  browser: string;
}

export async function listReplays(
  ctx: OrgContext,
  input: { stack: string; days?: number; withErrors?: boolean; userId?: string; limit?: number },
): Promise<{ status: RumStatus; sessions: ReplaySessionView[] }> {
  const client = await ch(ctx);
  if (!client) return { status: 'disabled', sessions: [] };
  try {
    const r = await rows<Record<string, unknown>>(client, buildReplayListQuery(ctx.activeOrgId, input.stack, input));
    return {
      status: 'ok',
      sessions: r.map((x) => ({
        sessionId: String(x.session_id),
        startedAt: String(x.started_at),
        endedAt: String(x.ended_at),
        durationMs: num(x.duration_ms),
        events: num(x.events),
        bytes: num(x.bytes),
        clicks: num(x.clicks),
        errors: num(x.errors),
        requests: num(x.requests),
        chunks: num(x.chunks),
        firstPath: String(x.first_path ?? ''),
        userId: String(x.user_id ?? ''),
        country: String(x.country ?? ''),
        device: String(x.device ?? ''),
        browser: String(x.browser ?? ''),
      })),
    };
  } catch {
    return { status: 'unreachable', sessions: [] };
  }
}

export interface ReplayTimelineRequest {
  traceId: string;
  spanId: string;
  service: string;
  name: string;
  startMs: number;
  durationMs: number;
  status: string;
  method: string;
  path: string;
  httpStatus: string;
}

export interface ReplayDetailView {
  status: RumStatus | 'not-found' | 'no-store';
  sessionId: string;
  meta: { userId: string; country: string; device: string; browser: string; startedAt: string; endedAt: string } | null;
  /** rrweb events, in order (chunks concatenated). */
  events: unknown[];
  /** Server spans for the browser's requests (edge + app), linked by traceparent / session id. */
  requests: ReplayTimelineRequest[];
  logs: Array<{ tsMs: number; severity: string; service: string; body: string; traceId: string }>;
  /** Server-side errors from the error-tracking store linked by replay_id (empty when absent). */
  errors: Array<Record<string, unknown>>;
}

interface ChunkRow {
  seq: number;
  object_key: string;
  start_ts: string;
  end_ts: string;
  trace_ids: string[];
  user_id: string;
  country: string;
  device: string;
  browser: string;
  day: string;
}

function toMs(chTs: string): number {
  const t = Date.parse(`${chTs.replace(' ', 'T')}Z`);
  return Number.isFinite(t) ? t : 0;
}

export async function getReplay(ctx: OrgContext, input: { stack: string; sessionId: string }): Promise<ReplayDetailView> {
  const base: ReplayDetailView = { status: 'disabled', sessionId: input.sessionId, meta: null, events: [], requests: [], logs: [], errors: [] };
  if (!SESSION_ID_RE.test(input.sessionId)) return { ...base, status: 'not-found' };
  const client = await ch(ctx);
  if (!client) return base;
  let chunks: ChunkRow[];
  try {
    chunks = await rows<ChunkRow>(client, buildReplayChunksQuery(ctx.activeOrgId, input.stack, input.sessionId));
  } catch {
    return { ...base, status: 'unreachable' };
  }
  if (chunks.length === 0) return { ...base, status: 'not-found' };
  const store = await rumBlobStore(ctx).catch(() => null);
  if (!store) return { ...base, status: 'no-store' };

  const events: unknown[] = [];
  for (const c of chunks) {
    const blob = await store.get(c.object_key).catch(() => null);
    if (!blob) continue;
    try {
      const parsed = JSON.parse(gunzipSync(blob).toString('utf8')) as { events?: unknown[] };
      if (Array.isArray(parsed.events)) events.push(...parsed.events);
    } catch {
      /* a corrupt chunk loses its own events only */
    }
  }
  const first = chunks[0]!;
  const last = chunks[chunks.length - 1]!;
  const window = { fromMs: toMs(first.start_ts), toMs: toMs(last.end_ts) };
  const traceIds = [...new Set(chunks.flatMap((c) => c.trace_ids ?? []))];

  const [requests, logs, errors] = await Promise.all([
    rows<Record<string, unknown>>(client, buildReplayRequestsQuery(ctx.activeOrgId, input.sessionId, traceIds, window)).catch(() => []),
    (async () => {
      const sql = buildReplayLogsQuery(ctx.activeOrgId, traceIds, window);
      return sql ? rows<Record<string, unknown>>(client, sql).catch(() => []) : [];
    })(),
    rows<Record<string, unknown>>(client, buildReplayErrorsQuery(ctx.activeOrgId, input.sessionId)).catch(() => []),
  ]);

  // Viewing a replay is viewing personal data — audited.
  await writeAudit(ctx, {
    action: 'rum.replay.view',
    targetType: 'stack',
    targetId: input.stack,
    metadata: { sessionId: input.sessionId },
  }).catch(() => undefined);

  return {
    status: 'ok',
    sessionId: input.sessionId,
    meta: {
      userId: chunks.find((c) => c.user_id)?.user_id ?? '',
      country: first.country,
      device: first.device,
      browser: first.browser,
      startedAt: first.start_ts,
      endedAt: last.end_ts,
    },
    events,
    requests: requests.map((r) => ({
      traceId: String(r.trace_id),
      spanId: String(r.span_id),
      service: String(r.service_name),
      name: String(r.span_name),
      startMs: num(r.start_ms),
      durationMs: num(r.duration_ms),
      status: String(r.status_code ?? ''),
      method: String(r.method ?? ''),
      path: String(r.path ?? ''),
      httpStatus: String(r.http_status ?? ''),
    })),
    logs: logs.map((l) => ({
      tsMs: num(l.ts_ms),
      severity: String(l.severity ?? ''),
      service: String(l.service_name ?? ''),
      body: String(l.body ?? '').slice(0, 2000),
      traceId: String(l.trace_id ?? ''),
    })),
    errors,
  };
}

/** Deep link helper for other slices (error tracking): null when no such replay. */
export async function replayLinkFor(
  ctx: OrgContext,
  input: { stack: string; sessionId: string },
): Promise<{ sessionId: string; startedAt: string; url: string } | null> {
  if (!SESSION_ID_RE.test(input.sessionId)) return null;
  const client = await ch(ctx);
  if (!client) return null;
  const r = await rows<ChunkRow>(client, buildReplayChunksQuery(ctx.activeOrgId, input.stack, input.sessionId)).catch(() => []);
  if (!r[0]) return null;
  return {
    sessionId: input.sessionId,
    startedAt: r[0].start_ts,
    url: `/stacks/${encodeURIComponent(input.stack)}/replays/${input.sessionId}`,
  };
}

// ── GDPR ───────────────────────────────────────────────────────────────

export interface DeleteResult {
  sessions: number;
  objects: number;
}

async function deleteOneSession(ctx: OrgContext, client: ClickhouseClient, stack: string, sessionId: string): Promise<number> {
  const chunks = await rows<ChunkRow>(client, buildReplayChunksQuery(ctx.activeOrgId, stack, sessionId));
  let objects = 0;
  const store = chunks.length ? await rumBlobStore(ctx).catch(() => null) : null;
  if (store) {
    for (const day of new Set(chunks.map((c) => c.day))) {
      objects += await deletePrefix(store, replaySessionPrefix(ctx.activeOrgId, stack, day, sessionId));
    }
  }
  for (const sql of buildDeleteSessionStatements(ctx.activeOrgId, stack, sessionId)) await client.exec(sql);
  return objects;
}

/** Delete one session everywhere (replay chunks, replay index, its analytics rows). */
export async function deleteSession(ctx: OrgContext, input: { stack: string; sessionId: string }): Promise<DeleteResult> {
  if (!SESSION_ID_RE.test(input.sessionId)) return { sessions: 0, objects: 0 };
  const client = await ch(ctx);
  if (!client) return { sessions: 0, objects: 0 };
  const objects = await deleteOneSession(ctx, client, input.stack, input.sessionId);
  await writeAudit(ctx, {
    action: 'rum.gdpr.deleteSession',
    targetType: 'stack',
    targetId: input.stack,
    metadata: { sessionId: input.sessionId, objects },
  });
  return { sessions: 1, objects };
}

/** Delete every session and analytics row tied to one user id (one app, or all of the org's apps). */
export async function deleteUser(ctx: OrgContext, input: { stack?: string; userId: string }): Promise<DeleteResult> {
  const client = await ch(ctx);
  if (!client || !input.userId) return { sessions: 0, objects: 0 };
  const sessions = await rows<{ app: string; session_id: string }>(
    client,
    buildUserSessionsQuery(ctx.activeOrgId, input.stack ?? null, input.userId),
  );
  let objects = 0;
  const seen = new Set<string>();
  for (const s of sessions) {
    const k = `${s.app}/${s.session_id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    objects += await deleteOneSession(ctx, client, s.app, s.session_id);
  }
  for (const sql of buildDeleteUserStatements(ctx.activeOrgId, input.stack ?? null, input.userId)) await client.exec(sql);
  await writeAudit(ctx, {
    action: 'rum.gdpr.deleteUser',
    targetType: 'stack',
    targetId: input.stack ?? '*',
    metadata: { userId: input.userId, sessions: seen.size, objects },
  });
  return { sessions: seen.size, objects };
}

export async function footprint(
  ctx: OrgContext,
  stack: string,
): Promise<{ eventRows: number; replaySessions: number; replayBytes: number; replaySessions24h: number; visitors24h: number } | null> {
  const client = await ch(ctx);
  if (!client) return null;
  const r = await rows<Record<string, unknown>>(client, buildFootprintQuery(ctx.activeOrgId, stack)).catch(() => []);
  const x = r[0];
  if (!x) return null;
  return {
    eventRows: num(x.event_rows),
    replaySessions: num(x.replay_sessions),
    replayBytes: num(x.replay_bytes),
    replaySessions24h: num(x.replay_sessions_24h),
    visitors24h: num(x.visitors_24h),
  };
}
