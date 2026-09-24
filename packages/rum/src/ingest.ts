import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RumTokenClaims } from './token';

/**
 * Ingest parsing — pure. The browser sends small JSON batches; everything is
 * validated, bounded and normalised here before any row is built, so the
 * store only ever sees data swarmy chose to keep.
 *
 * PRIVACY MODE (claims.m = 'a') keeps NO personal data: no IP, no user agent,
 * no ids. Unique visitors are counted with a daily-rotating salted hash of
 * (app, IP, UA) — computed here, never stored alongside its inputs, and
 * useless after the day's salt rotates (the Plausible approach).
 */

/** Hard caps (the endpoint also rate-limits per app + client). */
export const MAX_BATCH_BYTES = 64 * 1024;
export const MAX_BATCH_EVENTS = 50;
export const MAX_REPLAY_CHUNK_BYTES = 2 * 1024 * 1024;
export const MAX_REPLAY_SEQ = 5000;

const str = (max: number) => z.string().max(max * 4).transform((s) => s.slice(0, max));

export const RumBeaconEventSchema = z.object({
  /** pv = pageview, ev = custom event, lv = leave (engagement time). */
  t: z.enum(['pv', 'ev', 'lv']),
  /** Page URL (full); reduced to path + utm on the server. */
  u: str(2048),
  /** document.referrer. */
  r: str(2048).optional(),
  /** Custom event name (ev only). */
  n: str(80).optional(),
  /** Viewport width → device class (no raw UA kept). */
  w: z.number().int().min(0).max(20000).optional(),
  /** Engaged milliseconds on the page (lv only). */
  d: z.number().int().min(0).max(24 * 3600 * 1000).optional(),
  /** Client timestamp (ms); only used when within skew of the server clock. */
  ts: z.number().optional(),
  /** Session id (identified mode only; dropped otherwise). */
  sid: z.string().regex(/^[0-9a-z]{10,40}$/).optional(),
});
export type RumBeaconEvent = z.infer<typeof RumBeaconEventSchema>;

export const RumBeaconSchema = z.object({
  v: z.literal(1),
  e: z.array(RumBeaconEventSchema).min(1).max(MAX_BATCH_EVENTS),
});

/** One analytics row, exactly the columns of `swarmy_rum_events`. */
export interface RumEventRow {
  ts: string; // 'YYYY-MM-DD hh:mm:ss.mmm' UTC
  org_id: string;
  app: string;
  retention_days: number;
  kind: string;
  host: string;
  path: string;
  referrer_host: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  country: string;
  device: string;
  browser: string;
  visitor_hash: string; // UInt64 as decimal string
  session_id: string;
  user_id: string;
  event_name: string;
  engaged_ms: number;
}

export interface IngestClient {
  ip: string;
  userAgent: string;
  /** Two-letter country from swarmy's GeoIP, or ''. */
  country: string;
  /** Verified user id (identified mode only; from the app-auth session, never the body). */
  userId?: string;
  now: Date;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; status: number; reason: string };

/** Parse a beacon body (a JSON string). */
export function parseBeacon(body: string): ParseResult<RumBeaconEvent[]> {
  if (body.length > MAX_BATCH_BYTES) return { ok: false, status: 413, reason: 'batch too large' };
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, status: 400, reason: 'invalid json' };
  }
  const parsed = RumBeaconSchema.safeParse(json);
  if (!parsed.success) return { ok: false, status: 400, reason: 'invalid batch' };
  return { ok: true, value: parsed.data.e };
}

// ── bots ────────────────────────────────────────────────────────────────

const BOT_UA =
  /bot|crawl|spider|slurp|facebookexternalhit|embedly|quora link preview|preview|headlesschrome|phantomjs|lighthouse|pingdom|uptime|monitor|curl\/|wget\/|python-requests|httpclient|go-http-client|java\/|okhttp|axios\/|node-fetch|scrapy|ahrefs|semrush|mj12|yandex|baiduspider|bingpreview|petalbot|gptbot|claudebot|ccbot|bytespider/i;

/**
 * Obvious automation is dropped before counting. `allowHeadless` exists for
 * swarmy's own e2e (a headless browser session is recorded on purpose).
 */
export function isBot(userAgent: string, opts: { allowHeadless?: boolean } = {}): boolean {
  if (!userAgent || userAgent.length < 10) return true;
  if (opts.allowHeadless && /headlesschrome/i.test(userAgent) && !/bot|crawl|spider/i.test(userAgent)) return false;
  return BOT_UA.test(userAgent);
}

// ── normalisation ───────────────────────────────────────────────────────

export function deviceClass(width: number | undefined, userAgent: string): 'mobile' | 'tablet' | 'desktop' | 'unknown' {
  if (width && width > 0) {
    if (width < 600) return 'mobile';
    if (width < 1024) return 'tablet';
    return 'desktop';
  }
  if (/iPad|Tablet/i.test(userAgent)) return 'tablet';
  if (/Mobi|Android|iPhone/i.test(userAgent)) return 'mobile';
  return userAgent ? 'desktop' : 'unknown';
}

/** Browser FAMILY only (no version, no OS build) — coarse on purpose. */
export function browserFamily(userAgent: string): string {
  if (/Edg\//.test(userAgent)) return 'Edge';
  if (/OPR\/|Opera/.test(userAgent)) return 'Opera';
  if (/Firefox\//.test(userAgent)) return 'Firefox';
  if (/Chrome\/|CriOS\//.test(userAgent)) return 'Chrome';
  if (/Safari\//.test(userAgent)) return 'Safari';
  return 'Other';
}

const UTM_MAX = 100;

/** Page URL → host, path (no query except utm_*, no fragment). */
export function normalisePage(raw: string): { host: string; path: string; utm: { source: string; medium: string; campaign: string } } {
  try {
    const u = new URL(raw);
    const utm = {
      source: (u.searchParams.get('utm_source') ?? '').slice(0, UTM_MAX),
      medium: (u.searchParams.get('utm_medium') ?? '').slice(0, UTM_MAX),
      campaign: (u.searchParams.get('utm_campaign') ?? '').slice(0, UTM_MAX),
    };
    let path = u.pathname || '/';
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    return { host: u.hostname.toLowerCase(), path: path.slice(0, 512), utm };
  } catch {
    return { host: '', path: '/', utm: { source: '', medium: '', campaign: '' } };
  }
}

/** Referrer → host only; same-site (and empty) referrers read as direct (''). */
export function referrerHost(referrer: string | undefined, pageHost: string): string {
  if (!referrer) return '';
  try {
    const h = new URL(referrer).hostname.toLowerCase().replace(/^www\./, '');
    if (!h || h === pageHost.replace(/^www\./, '')) return '';
    return h.slice(0, 253);
  } catch {
    return '';
  }
}

/**
 * Daily visitor hash: SHA-256(salt(day) ‖ app ‖ ip ‖ ua) → first 8 bytes as
 * UInt64. The salt is derived from the controller secret and the UTC day, so
 * yesterday's hashes cannot be linked to today's.
 */
export function visitorHash(secret: string, day: string, app: string, ip: string, ua: string): string {
  const salt = createHash('sha256').update(`rum-salt:${secret}:${day}`).digest('hex');
  const h = createHash('sha256').update(`${salt}\0${app}\0${ip}\0${ua}`).digest();
  return h.readBigUInt64BE(0).toString();
}

export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** ClickHouse DateTime64(3) literal (UTC). */
export function chTime(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Build store rows from a parsed batch, enforcing the token's mode. */
export function buildEventRows(
  claims: RumTokenClaims,
  events: RumBeaconEvent[],
  client: IngestClient,
  secret: string,
): RumEventRow[] {
  const identified = claims.m === 'i';
  const day = utcDay(client.now);
  const vh = visitorHash(secret, day, `${claims.o}/${claims.a}`, client.ip, client.userAgent);
  const browser = browserFamily(client.userAgent);
  return events.map((e) => {
    const page = normalisePage(e.u);
    const ts =
      typeof e.ts === 'number' && Math.abs(e.ts - client.now.getTime()) < MAX_CLOCK_SKEW_MS
        ? new Date(e.ts)
        : client.now;
    return {
      ts: chTime(ts),
      org_id: claims.o,
      app: claims.a,
      retention_days: claims.r,
      kind: e.t,
      host: page.host,
      path: page.path,
      referrer_host: e.t === 'pv' ? referrerHost(e.r, page.host) : '',
      utm_source: page.utm.source,
      utm_medium: page.utm.medium,
      utm_campaign: page.utm.campaign,
      country: /^[A-Z]{2}$/.test(client.country) ? client.country : '',
      device: deviceClass(e.w, client.userAgent),
      browser,
      visitor_hash: vh,
      // Identified mode only — a privacy-mode token drops every id the browser sent.
      session_id: identified ? (e.sid ?? '') : '',
      user_id: identified ? (client.userId ?? '') : '',
      event_name: e.t === 'ev' ? (e.n ?? '').slice(0, 80) : '',
      engaged_ms: e.t === 'lv' ? (e.d ?? 0) : 0,
    };
  });
}

// ── replay chunks ───────────────────────────────────────────────────────

export const SESSION_ID_RE = /^[0-9a-z]{10,40}$/;

export interface ReplayChunkMeta {
  sessionId: string;
  seq: number;
}

/** Validate the chunk coordinates from the query string. */
export function parseChunkCoordinates(sid: string | undefined, seq: string | undefined): ParseResult<ReplayChunkMeta> {
  if (!sid || !SESSION_ID_RE.test(sid)) return { ok: false, status: 400, reason: 'invalid session id' };
  const n = Number(seq);
  if (!Number.isInteger(n) || n < 0 || n > MAX_REPLAY_SEQ) return { ok: false, status: 400, reason: 'invalid seq' };
  return { ok: true, value: { sessionId: sid, seq: n } };
}

/** rrweb event shape (only what the index needs). */
interface RrwebEventLite {
  type: number;
  timestamp: number;
  data?: { source?: number; type?: number; tag?: string; payload?: Record<string, unknown>; href?: string };
}

export interface ReplayChunkSummary {
  events: number;
  startMs: number;
  endMs: number;
  /** First page URL seen in the chunk (Meta event href), path only. */
  firstPath: string;
  clicks: number;
  errors: number;
  requests: number;
  /** Trace ids of requests the chunk recorded (swarmy.request custom events). */
  traceIds: string[];
}

const RR_META = 4;
const RR_INCREMENTAL = 3;
const RR_CUSTOM = 5;
const RR_SRC_MOUSE_INTERACTION = 2;
const RR_MOUSE_CLICK = 2;

export const ReplayChunkSchema = z.object({
  v: z.literal(1),
  events: z
    .array(z.object({ type: z.number().int(), timestamp: z.number() }).passthrough())
    .min(1)
    .max(20000),
});

/** Parse a replay chunk JSON body and summarise it for the index. */
export function parseReplayChunk(json: string): ParseResult<{ events: RrwebEventLite[]; summary: ReplayChunkSummary }> {
  if (json.length > MAX_REPLAY_CHUNK_BYTES * 4) return { ok: false, status: 413, reason: 'chunk too large' };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, status: 400, reason: 'invalid json' };
  }
  const parsed = ReplayChunkSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, status: 400, reason: 'invalid chunk' };
  const events = parsed.data.events as unknown as RrwebEventLite[];
  const s: ReplayChunkSummary = {
    events: events.length,
    startMs: Infinity,
    endMs: 0,
    firstPath: '',
    clicks: 0,
    errors: 0,
    requests: 0,
    traceIds: [],
  };
  const traces = new Set<string>();
  for (const e of events) {
    s.startMs = Math.min(s.startMs, e.timestamp);
    s.endMs = Math.max(s.endMs, e.timestamp);
    if (e.type === RR_META && !s.firstPath && typeof e.data?.href === 'string') {
      s.firstPath = normalisePage(e.data.href).path;
    } else if (e.type === RR_INCREMENTAL && e.data?.source === RR_SRC_MOUSE_INTERACTION && e.data?.type === RR_MOUSE_CLICK) {
      s.clicks++;
    } else if (e.type === RR_CUSTOM) {
      if (e.data?.tag === 'swarmy.error') s.errors++;
      if (e.data?.tag === 'swarmy.request') {
        s.requests++;
        const tid = e.data.payload?.traceId;
        if (typeof tid === 'string' && /^[0-9a-f]{32}$/.test(tid)) traces.add(tid);
        if (typeof e.data.payload?.status === 'number' && (e.data.payload.status as number) >= 500) s.errors++;
      }
      if (e.data?.tag === 'swarmy.navigation') {
        const tid = e.data.payload?.traceId;
        if (typeof tid === 'string' && /^[0-9a-f]{32}$/.test(tid)) traces.add(tid);
      }
    }
  }
  if (!Number.isFinite(s.startMs)) s.startMs = 0;
  s.traceIds = [...traces].slice(0, 500);
  return { ok: true, value: { events, summary: s } };
}

/** One index row per stored chunk (`swarmy_rum_replays`). */
export interface ReplayIndexRow {
  org_id: string;
  app: string;
  session_id: string;
  seq: number;
  day: string;
  start_ts: string;
  end_ts: string;
  events: number;
  bytes: number;
  first_path: string;
  clicks: number;
  errors: number;
  requests: number;
  trace_ids: string[];
  user_id: string;
  country: string;
  device: string;
  browser: string;
  object_key: string;
  retention_days: number;
}
