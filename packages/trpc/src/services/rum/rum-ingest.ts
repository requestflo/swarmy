/**
 * The public RUM endpoint, mounted by the controller at `/_rum/*`. The edge
 * maps `/_swarmy/*` on every RUM-enabled app domain onto it, so to the
 * browser it is first-party.
 *
 *   GET  /_rum/rum.js          the analytics script (every page)
 *   GET  /_rum/replay.js       the rrweb recorder (sampled, consented sessions)
 *   POST /_rum/rum?app=…       analytics batch (≤ 50 events, ≤ 64 KiB)
 *   POST /_rum/replay?app=…&sid=…&seq=…   one replay chunk (≤ 2 MiB)
 *
 * UNAUTHENTICATED by necessity (any visitor's browser posts here), so every
 * request is: token-verified (org + app + mode come from the signed token,
 * never the body), size-capped, bot-filtered, and rate-limited per app and
 * per client. A privacy-mode token can never store ids or replays.
 */
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  RUM_EVENTS_TABLE,
  RUM_REPLAYS_TABLE,
  TokenBuckets,
  buildEventRows,
  browserFamily,
  chTime,
  countryOf,
  deviceClass,
  isBot,
  parseBeacon,
  parseChunkCoordinates,
  parseReplayChunk,
  replayChunkKey,
  utcDay,
  verifyRumToken,
  MAX_BATCH_BYTES,
  MAX_REPLAY_CHUNK_BYTES,
  type ReplayIndexRow,
  type RumTokenClaims,
} from '@swarmy/rum';
import { rumBundles } from '@swarmy/rum/build';
import type { OrgContext } from '../../context';
import { APP_COOKIE_PLAIN, APP_COOKIE_SECURE, parseCookies } from '../app-access.service';
import { openToken, type AppCookie } from '../app-access-tokens';
import { rumBlobStore, rumClickhouse } from './rum-store';
import { rumSecret } from './rum-settings.service';

export interface RumIngestDeps {
  /** A system OrgContext for an org (store resolution, Garage provisioning). */
  ctxFor(orgId: string): OrgContext;
  /** Header the controller's front door sets with the resolved client IP. */
  clientIpHeader: string;
  now?: () => number;
  /** e2e only: count HeadlessChrome sessions instead of dropping them. */
  allowHeadless?: boolean;
}

/** Per app: 200 req/s burst 400. Per client: 5 req/s burst 30 (a busy SPA + replay). */
const perApp = new TokenBuckets({ ratePerSec: 200, burst: 400 });
const perClient = new TokenBuckets({ ratePerSec: 5, burst: 30 });

const TEXT = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };

function reply(status: number, body = ''): Response {
  return new Response(body, { status, headers: TEXT });
}

async function readBody(req: Request, max: number): Promise<{ text: string } | { error: Response }> {
  const len = Number(req.headers.get('content-length') ?? '0');
  if (len > max) return { error: reply(413, 'too large') };
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.byteLength > max) return { error: reply(413, 'too large') };
  let bytes = buf;
  if ((req.headers.get('content-encoding') ?? '').toLowerCase() === 'gzip') {
    try {
      bytes = new Uint8Array(gunzipSync(buf, { maxOutputLength: max * 4 }));
    } catch {
      return { error: reply(400, 'bad gzip') };
    }
  }
  return { text: new TextDecoder().decode(bytes) };
}

/** The verified app-auth user on this host (identified mode only), from the first-party app cookie. */
function verifiedUser(req: Request, claims: RumTokenClaims, host: string): string | undefined {
  if (claims.m !== 'i') return undefined;
  const cookies = parseCookies(req.headers.get('cookie') ?? '');
  const raw = cookies.get(APP_COOKIE_SECURE) ?? cookies.get(APP_COOKIE_PLAIN);
  if (!raw) return undefined;
  try {
    const c = openToken<AppCookie>('cookie', raw);
    if (c && c.org === claims.o && c.host === host) return c.uid;
  } catch {
    /* no secret / malformed ⇒ anonymous */
  }
  return undefined;
}

function hostOf(req: Request): string {
  const h = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? '';
  return h.split(',')[0]!.trim().toLowerCase().replace(/:\d+$/, '');
}

export async function handleRumRequest(deps: RumIngestDeps, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/_rum/, '') || '/';

  if (req.method === 'GET' && (path === '/rum.js' || path === '/replay.js')) {
    const b = await rumBundles();
    const which = path === '/rum.js' ? 'rum' : 'replay';
    const etag = `"${b.etag[which]}"`;
    if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } });
    const body = b[which];
    const gz = /\bgzip\b/.test(req.headers.get('accept-encoding') ?? '');
    return new Response(gz ? gzipSync(body) : body, {
      headers: {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'public, max-age=300',
        etag,
        vary: 'Accept-Encoding',
        ...(gz ? { 'content-encoding': 'gzip' } : {}),
        'x-content-type-options': 'nosniff',
      },
    });
  }

  if (req.method !== 'POST' || (path !== '/rum' && path !== '/replay')) return reply(404, 'not found');

  let secret: string;
  try {
    secret = rumSecret();
  } catch {
    return reply(503, 'rum unavailable');
  }
  const claims = verifyRumToken(secret, url.searchParams.get('app'));
  if (!claims) return reply(403, 'unknown app');

  const ua = req.headers.get('user-agent') ?? '';
  // Bots get a quiet 204: nothing to retry, nothing stored.
  if (isBot(ua, { allowHeadless: deps.allowHeadless })) return reply(204);

  const ip = req.headers.get(deps.clientIpHeader) ?? '';
  const now = new Date(deps.now ? deps.now() : Date.now());
  if (!perApp.take(`${claims.o}/${claims.a}`, now.getTime()) || !perClient.take(`${claims.o}/${claims.a}/${ip}`, now.getTime())) {
    return new Response('slow down', { status: 429, headers: { ...TEXT, 'retry-after': '5' } });
  }

  const ctx = deps.ctxFor(claims.o);
  const client = await rumClickhouse(ctx, claims.o).catch(() => null);
  if (!client) return reply(503, 'analytics store is off');

  const host = hostOf(req);

  if (path === '/rum') {
    const body = await readBody(req, MAX_BATCH_BYTES);
    if ('error' in body) return body.error;
    const parsed = parseBeacon(body.text);
    if (!parsed.ok) return reply(parsed.status, parsed.reason);
    const rows = buildEventRows(
      claims,
      parsed.value,
      { ip, userAgent: ua, country: countryOf(ip), userId: verifiedUser(req, claims, host), now },
      secret,
    );
    try {
      await client.insert(RUM_EVENTS_TABLE, rows);
    } catch {
      return reply(503, 'store unavailable');
    }
    return reply(204);
  }

  // ── replay chunk ────────────────────────────────────────────────
  if (claims.m !== 'i' || claims.s <= 0) return reply(403, 'replay is off for this app');
  const coords = parseChunkCoordinates(url.searchParams.get('sid') ?? undefined, url.searchParams.get('seq') ?? undefined);
  if (!coords.ok) return reply(coords.status, coords.reason);
  // A chunk costs more than a beacon.
  if (!perClient.take(`${claims.o}/${claims.a}/${ip}`, now.getTime(), 2)) return reply(429, 'slow down');
  const body = await readBody(req, MAX_REPLAY_CHUNK_BYTES);
  if ('error' in body) return body.error;
  const chunk = parseReplayChunk(body.text);
  if (!chunk.ok) return reply(chunk.status, chunk.reason);

  const store = await rumBlobStore(ctx).catch(() => null);
  if (!store) return reply(503, 'object storage is off');
  const day = utcDay(now);
  const key = replayChunkKey(claims.o, claims.a, day, coords.value.sessionId, coords.value.seq);
  const gz = gzipSync(JSON.stringify({ v: 1, events: chunk.value.events }));
  try {
    await store.put(key, new Uint8Array(gz));
  } catch {
    return reply(503, 'object storage unavailable');
  }
  const s = chunk.value.summary;
  const skewOk = (ms: number) => Math.abs(ms - now.getTime()) < 24 * 3600_000;
  const row: ReplayIndexRow = {
    org_id: claims.o,
    app: claims.a,
    session_id: coords.value.sessionId,
    seq: coords.value.seq,
    day,
    start_ts: chTime(new Date(skewOk(s.startMs) ? s.startMs : now.getTime())),
    end_ts: chTime(new Date(skewOk(s.endMs) ? s.endMs : now.getTime())),
    events: s.events,
    bytes: gz.byteLength,
    first_path: s.firstPath,
    clicks: s.clicks,
    errors: s.errors,
    requests: s.requests,
    trace_ids: s.traceIds,
    user_id: verifiedUser(req, claims, host) ?? '',
    country: countryOf(ip),
    device: deviceClass(undefined, ua),
    browser: browserFamily(ua),
    object_key: key,
    retention_days: claims.r,
  };
  try {
    await client.insert(RUM_REPLAYS_TABLE, [row]);
  } catch {
    return reply(503, 'store unavailable');
  }
  return reply(204);
}
