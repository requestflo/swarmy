/**
 * `getSession(req)` — who is calling, for an app behind swarmy auth, with no
 * auth code of the app's own. Two sources, tried in order:
 *
 * 1. **Protect my app** (identity-aware proxy). The swarmy edge already
 *    authenticated the caller and forwards `X-Swarmy-Jwt` (plus plain
 *    `X-Swarmy-User/-Email/-Groups`, which the edge strips from clients). The
 *    JWT is verified against the controller's JWKS and must be addressed to
 *    this app's host — so a token minted for another app is refused.
 * 2. **End-user auth** (`auth:` in swarmy.yaml). The app's own Better Auth
 *    service (routed at `/auth/*` on the app's domain; swarmy injects its
 *    in-swarm address as `SWARMY_AUTH_URL`) issues the session. A bearer JWT
 *    is verified directly; a browser session cookie is exchanged at the auth
 *    service's `/auth/token` for a short-lived JWT (cached until it expires),
 *    then verified against the service's JWKS.
 *
 * Returns `null` when nobody is signed in or any check fails — never throws
 * for a bad token.
 */
import { JwtError, remoteJwks, verifyWithJwks, type JwtClaims, type RemoteJwks } from './jwt';

export const SWARMY_JWT_HEADER = 'x-swarmy-jwt';
/** Default controller JWKS on the swarmy overlay (`SWARMY_JWKS_URL` overrides). */
export const DEFAULT_SWARMY_JWKS_URL = 'http://swarmy_controller:3021/.well-known/swarmy-jwks.json';
/** Better Auth base path swarmy mounts the per-app auth service on. */
export const APP_AUTH_BASE_PATH = '/auth';

export interface SessionUser {
  id: string;
  email: string | null;
  name: string | null;
  groups: string[];
}

export interface SwarmySession {
  user: SessionUser;
  /** `proxy` = Protect my app (swarmy identity); `app` = the app's own auth service. */
  source: 'proxy' | 'app';
  /** Verified JWT claims. */
  claims: JwtClaims;
  /** The verified JWT (forward it to your own APIs as a bearer token). */
  token: string;
}

/** Anything with headers: a Fetch `Request`, a Node `IncomingMessage`, or `{ headers }`. */
export type RequestLike =
  | { headers: Headers }
  | { headers: Record<string, string | string[] | undefined> };

export interface GetSessionOptions {
  /** Controller JWKS for proxy tokens. Default `SWARMY_JWKS_URL`, else the overlay address. */
  swarmyJwksUrl?: string;
  /** The app's auth service base URL (no path). Default `SWARMY_AUTH_URL`; unset ⇒ proxy only. */
  authUrl?: string;
  /** Expected audience of proxy tokens. Default: the request's Host. */
  audience?: string | string[];
  /** Expected issuer(s) of proxy tokens. Default: not checked (the JWKS is the trust anchor). */
  issuer?: string | string[];
  fetch?: typeof fetch;
  /** Current time in ms (tests). */
  now?: number;
}

function env(name: string): string | undefined {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return p?.env?.[name];
}

export function readHeader(req: RequestLike, name: string): string | undefined {
  const h = req.headers as Headers | Record<string, string | string[] | undefined>;
  if (typeof (h as Headers).get === 'function') return (h as Headers).get(name) ?? undefined;
  const rec = h as Record<string, string | string[] | undefined>;
  const v = rec[name.toLowerCase()] ?? Object.entries(rec).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
  return Array.isArray(v) ? v[0] : v;
}

/** The request host without port, lowercased (X-Forwarded-Host wins — the edge sets it). */
export function requestHost(req: RequestLike): string | undefined {
  const raw = readHeader(req, 'x-forwarded-host') ?? readHeader(req, 'host');
  const first = raw?.split(',')[0]?.trim().toLowerCase();
  if (!first) return undefined;
  return first.startsWith('[') ? first.slice(0, first.indexOf(']') + 1) : first.replace(/:\d+$/, '');
}

const jwksCache = new Map<string, RemoteJwks>();
function jwksFor(url: string, f?: typeof fetch): RemoteJwks {
  const key = url;
  let j = jwksCache.get(key);
  if (!j) {
    j = remoteJwks(url, f ? { fetch: f } : {});
    jwksCache.set(key, j);
  }
  return j;
}

function userFrom(claims: JwtClaims): SessionUser | null {
  const id = typeof claims.sub === 'string' ? claims.sub : typeof claims.id === 'string' ? claims.id : null;
  if (!id) return null;
  const groups = Array.isArray(claims.groups) ? claims.groups.filter((g): g is string => typeof g === 'string') : [];
  return {
    id,
    email: typeof claims.email === 'string' && claims.email ? claims.email : null,
    name: typeof claims.name === 'string' && claims.name ? claims.name : null,
    groups,
  };
}

const exchanged = new Map<string, { token: string; exp: number }>();

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Exchange a Better Auth session cookie for a JWT at the app's auth service (cached). */
async function exchangeCookie(authUrl: string, cookie: string, f: typeof fetch, nowMs: number): Promise<string | null> {
  const key = await sha256(`${authUrl}\n${cookie}`);
  const hit = exchanged.get(key);
  if (hit && hit.exp - 30 > nowMs / 1000) return hit.token;
  const res = await f(`${authUrl.replace(/\/+$/, '')}${APP_AUTH_BASE_PATH}/token`, {
    headers: { cookie, accept: 'application/json' },
  }).catch(() => null);
  if (!res || !res.ok) {
    exchanged.delete(key);
    return null;
  }
  const body = (await res.json().catch(() => null)) as { token?: unknown } | null;
  const token = typeof body?.token === 'string' ? body.token : null;
  if (!token) return null;
  let exp = nowMs / 1000 + 60;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    if (typeof payload.exp === 'number') exp = payload.exp;
  } catch {
    /* keep the short default */
  }
  if (exchanged.size > 5000) exchanged.clear();
  exchanged.set(key, { token, exp });
  return token;
}

export async function getSession(req: RequestLike, opts: GetSessionOptions = {}): Promise<SwarmySession | null> {
  const f = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now();

  // 1. Protect my app: the edge-forwarded swarmy JWT, addressed to this host.
  const proxyToken = readHeader(req, SWARMY_JWT_HEADER);
  if (proxyToken) {
    const audience = opts.audience ?? requestHost(req);
    try {
      const claims = await verifyWithJwks(
        proxyToken,
        jwksFor(opts.swarmyJwksUrl ?? env('SWARMY_JWKS_URL') ?? DEFAULT_SWARMY_JWKS_URL, opts.fetch),
        { ...(audience ? { audience } : {}), ...(opts.issuer ? { issuer: opts.issuer } : {}), now },
      );
      const user = userFrom(claims);
      if (user) return { user, source: 'proxy', claims, token: proxyToken };
    } catch (e) {
      if (!(e instanceof JwtError)) throw e;
    }
  }

  // 2. The app's own auth service (swarmy.yaml `auth:`).
  const authUrl = opts.authUrl ?? env('SWARMY_AUTH_URL');
  if (!authUrl) return null;
  const jwks = jwksFor(`${authUrl.replace(/\/+$/, '')}${APP_AUTH_BASE_PATH}/jwks`, opts.fetch);
  const bearer = /^Bearer\s+(\S+)$/i.exec(readHeader(req, 'authorization') ?? '')?.[1];
  const cookie = readHeader(req, 'cookie');
  const token = bearer ?? (cookie ? await exchangeCookie(authUrl, cookie, f, now) : null);
  if (!token) return null;
  try {
    const claims = await verifyWithJwks(token, jwks, { now });
    const user = userFrom(claims);
    return user ? { user, source: 'app', claims, token } : null;
  } catch (e) {
    if (e instanceof JwtError) return null;
    throw e;
  }
}

/** Test hook: forget cached key sets and cookie exchanges. */
export function resetSessionCaches(): void {
  jwksCache.clear();
  exchanged.clear();
}
