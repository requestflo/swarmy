/**
 * "Protect my app" — the controller half of swarmy's identity-aware proxy
 * (dev-platform epic §2A). The edge (Caddy forward_auth / Traefik forwardAuth /
 * nginx auth_request, see `@swarmy/ingress` app-auth.ts) asks {@link verifyAppRequest}
 * about every request to a login-protected route; the answer decides:
 *
 *   200 + X-Swarmy-User/-Email/-Groups + X-Swarmy-Jwt  → proxied to the app
 *   302 to swarmy's login page (401 in nginx `status` mode) → not signed in
 *   403                                                  → signed in, not allowed
 *
 * Sign-in is swarmy's own (Better Auth: social / SSO / magic link / password).
 * The session never leaves the controller's domain: the round trip is
 *
 *   app  → 302 <controller>/app-login?rd=<url>         (SPA: sign in if needed)
 *        → <controller>/_app-auth/start?rd=<url>       (session + ABAC → one-time code)
 *        → 302 <app host>/.swarmy/auth/callback?code=… (edge maps to /_app-auth/callback)
 *        → Set-Cookie on the APP's domain (host-only, HttpOnly) → 302 back to <url>
 *
 * The app cookie only REFERENCES the swarmy session (id + user), so signing
 * out of swarmy or revoking the session ends app access within the cache TTL.
 * Who may enter is ABAC: the `app.access` action on the app's stack.
 *
 * Pure over its deps (db + live hub inventory + clock), so the HTTP adapter
 * (apps/api/src/app-auth.ts) stays thin and this is unit-tested directly.
 * State: none persisted — route toggles live on the `swarmy.ingress.routes`
 * label (`access.login`), keys are derived (app-access-tokens.ts), and the
 * one-time-code nonces + decision cache are in memory.
 */
import { randomBytes } from 'node:crypto';
import { buildInventory, UNGROUPED } from '@swarmy/core';
import { displayEmail } from '@swarmy/auth';
import type { ResourceInput } from '@swarmy/abac';
import type { DB } from '@swarmy/db';
import { APP_AUTH_ORIGINAL_URI_HEADER, APP_AUTH_MODE_HEADER, APP_AUTH_PATH_PREFIX } from '@swarmy/ingress';
import type { OrgContext } from '../context';
import type { AgentHub } from '../hub/types';
import { decide, liveStackLabels, principalFromMember } from '../abac';
import { writeAudit } from './audit.service';
import { readRoutes } from './ingress-routes';
import { openToken, sealToken, signAppJwt, type AppCookie, type AppLoginCode } from './app-access-tokens';

/** `__Host-` prefix: Secure, Path=/, no Domain — the browser guarantees it is this host's own. */
export const APP_COOKIE_SECURE = '__Host-swarmy-app';
/** Plain-http routes (tls off / local dev) cannot use the `__Host-` prefix. */
export const APP_COOKIE_PLAIN = 'swarmy-app';
/** App cookie lifetime cap; the swarmy session's own expiry is the other bound. */
export const APP_COOKIE_MAX_SECONDS = 12 * 3600;
export const LOGIN_CODE_TTL_SECONDS = 60;
/** How long a permit is reused for the same cookie + host (bounds revocation lag). */
export const DECISION_CACHE_MS = 15_000;

export interface AppAccessDeps {
  db: DB;
  hub: Pick<AgentHub, 'liveInventory'>;
  /** Controller public base URL (login redirects, JWT `iss`), no trailing slash. */
  publicUrl: string;
  now?: () => number;
}

export interface AppAuthResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body?: string;
}

// ── request shape ────────────────────────────────────────────────────────────

export interface EdgeRequest {
  /** Hostname (no port), lowercased. */
  host: string;
  /** Host as the browser typed it (keeps a non-default port for redirects). */
  hostWithPort: string;
  proto: 'http' | 'https';
  /** Path + query as the caller requested it, before any edge rewrite. */
  uri: string;
  method: string;
  accept: string;
  cookie: string;
  /** nginx auth_request: answer 401, never a redirect. */
  statusMode: boolean;
}

const first = (v: string | null | undefined): string | undefined => v?.split(',')[0]?.trim() || undefined;

export function stripPort(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.replace(/:\d+$/, '').replace(/\.$/, '');
}

/**
 * Read what the edge tells us. Only the forwarding headers the edge SETS are
 * used (Host/X-Forwarded-*, the original-URI header it writes on the auth
 * subrequest); identity headers a client may have sent are never read.
 */
export function edgeRequestFrom(headers: Headers): EdgeRequest {
  const hostWithPort = (first(headers.get('x-forwarded-host')) ?? first(headers.get('host')) ?? '').toLowerCase();
  const proto = first(headers.get('x-forwarded-proto')) === 'http' ? 'http' : 'https';
  const uri =
    first(headers.get(APP_AUTH_ORIGINAL_URI_HEADER)) ?? first(headers.get('x-forwarded-uri')) ?? '/';
  return {
    host: stripPort(hostWithPort),
    hostWithPort,
    proto,
    uri: uri.startsWith('/') ? uri : `/${uri}`,
    method: (first(headers.get('x-forwarded-method')) ?? 'GET').toUpperCase(),
    accept: headers.get('accept') ?? '',
    cookie: headers.get('cookie') ?? '',
    statusMode: headers.get(APP_AUTH_MODE_HEADER)?.trim().toLowerCase() === 'status',
  };
}

export function parseCookies(header: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    if (!out.has(k)) out.set(k, part.slice(eq + 1).trim());
  }
  return out;
}

// ── route lookup (Docker truth) ──────────────────────────────────────────────

export interface ProtectedRoute {
  orgId: string;
  host: string;
  path: string;
  serviceName: string;
  /** Docker stack of the owning service ('' when standalone). */
  stack: string;
}

function hostMatches(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) return host.endsWith(p.slice(1)) && host.length > p.length - 1;
  return p === host;
}

function pathOf(uri: string): string {
  const q = uri.search(/[?#]/);
  return q >= 0 ? uri.slice(0, q) : uri;
}

/**
 * The login-protected route serving `host` + `path` in this org, from the live
 * `swarmy.ingress.routes` labels: longest matching prefix among the host's
 * protected routes, else any protected route on the host (the edge only asks
 * for protected routes). Null ⇒ nothing here is protected — callers fail closed.
 */
export function findProtectedRoute(
  hub: Pick<AgentHub, 'liveInventory'>,
  orgId: string,
  host: string,
  path = '/',
): ProtectedRoute | null {
  const { services, containers } = hub.liveInventory(orgId);
  const candidates: ProtectedRoute[] = [];
  for (const s of buildInventory(services, containers).services) {
    for (const r of readRoutes(s.labels)) {
      if (!r.access?.login || !hostMatches(r.host, host)) continue;
      candidates.push({
        orgId,
        host: r.host.toLowerCase(),
        path: r.path && r.path.length > 0 ? r.path : '/',
        serviceName: s.name,
        stack: s.stack && s.stack !== UNGROUPED ? s.stack : '',
      });
    }
  }
  if (candidates.length === 0) return null;
  const matching = candidates
    .filter((c) => c.path === '/' || path.startsWith(c.path))
    .sort((a, b) => b.path.length - a.path.length);
  return matching[0] ?? candidates[0]!;
}

/** The ABAC resource an app login is evaluated on: its stack (or the lone service). */
export function appResource(hub: Pick<AgentHub, 'liveInventory'>, route: ProtectedRoute): ResourceInput {
  if (route.stack) {
    const labels =
      liveStackLabels({ hub, activeOrgId: route.orgId } as unknown as OrgContext, route.stack) ?? {};
    return { type: 'stack', id: route.stack, orgId: route.orgId, labels };
  }
  const { services, containers } = hub.liveInventory(route.orgId);
  const svc = buildInventory(services, containers).services.find((s) => s.name === route.serviceName);
  return { type: 'service', id: route.serviceName, orgId: route.orgId, labels: svc?.labels ?? {} };
}

// ── responses ────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function page(status: number, title: string, text: string, extra: Record<string, string | string[]> = {}): AppAuthResponse {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f7f9;color:#101828}main{max-width:28rem;padding:2rem}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:.25rem 0;color:#475467}a{color:#1d4ed8}</style></head><body><main><h1>${esc(title)}</h1>${text}</main></body></html>`;
  return {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...extra },
    body,
  };
}

function cookieName(proto: 'http' | 'https'): string {
  return proto === 'https' ? APP_COOKIE_SECURE : APP_COOKIE_PLAIN;
}

function clearCookies(): string[] {
  return [
    `${APP_COOKIE_SECURE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    `${APP_COOKIE_PLAIN}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
  ];
}

/** swarmy's login landing for an app URL (the SPA bounces through sign-in, then /_app-auth/start). */
export function appLoginUrl(publicUrl: string, returnTo: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/app-login?rd=${encodeURIComponent(returnTo)}`;
}

function unauthenticated(deps: AppAccessDeps, req: EdgeRequest, clear: boolean): AppAuthResponse {
  const returnTo = `${req.proto}://${req.hostWithPort}${req.uri}`;
  const login = appLoginUrl(deps.publicUrl, returnTo);
  const extra: Record<string, string | string[]> = clear ? { 'set-cookie': clearCookies() } : {};
  const navigation = (req.method === 'GET' || req.method === 'HEAD') && /text\/html|\*\/\*/.test(req.accept);
  if (req.statusMode || !navigation) {
    return {
      status: 401,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'www-authenticate': 'SwarmyLogin',
        'x-swarmy-login': login,
        ...extra,
      },
      body: JSON.stringify({ error: 'login required', login }),
    };
  }
  return { status: 302, headers: { location: login, 'cache-control': 'no-store', ...extra } };
}

// ── decision cache + throttled deny audit ────────────────────────────────────

const decisions = new Map<string, { at: number; res: AppAuthResponse }>();
const deniedAudit = new Map<string, number>();
const usedNonces = new Map<string, number>();

/** Test hook. */
export function resetAppAccessState(): void {
  decisions.clear();
  deniedAudit.clear();
  usedNonces.clear();
}

function sweep(map: Map<string, number>, olderThan: number): void {
  if (map.size < 2000) return;
  for (const [k, t] of map) if (t < olderThan) map.delete(k);
}

// ── session + decision ───────────────────────────────────────────────────────

interface Identity {
  uid: string;
  sid: string;
  email: string | null;
  name: string | null;
  sessionExpiresAt: Date;
}

/** The swarmy Better Auth session behind an id pair, if it is still live and fully signed in. */
async function liveSession(db: DB, sid: string, uid: string, now: number): Promise<Identity | null> {
  const s = await db.session.findFirst({
    where: { id: sid, userId: uid },
    select: { expiresAt: true, mfaPending: true },
  });
  if (!s || s.mfaPending || s.expiresAt.getTime() <= now) return null;
  const u = await db.user.findUnique({ where: { id: uid }, select: { email: true, name: true } });
  if (!u) return null;
  return { uid, sid, email: displayEmail(u.email), name: u.name || null, sessionExpiresAt: s.expiresAt };
}

interface Decision {
  permit: boolean;
  groups: string[];
  policyId: string | null;
  member: boolean;
}

async function decideAccess(
  deps: AppAccessDeps,
  route: ProtectedRoute,
  uid: string,
): Promise<Decision> {
  const m = await deps.db.member.findFirst({
    where: { organizationId: route.orgId, userId: uid },
    select: { id: true, userId: true, role: true, attributes: true },
  });
  if (!m) return { permit: false, groups: [], policyId: null, member: false };
  const principal = principalFromMember(route.orgId, m);
  const d = await decide({
    db: deps.db,
    orgId: route.orgId,
    principal,
    action: 'app.access',
    resource: appResource(deps.hub, route),
  });
  return { permit: d.decision === 'permit', groups: principal.groups ?? [], policyId: d.policyId, member: true };
}

async function auditDenied(deps: AppAccessDeps, route: ProtectedRoute, uid: string, policyId: string | null): Promise<void> {
  const now = (deps.now ?? Date.now)();
  const key = `${route.orgId}|${uid}|${route.host}`;
  if ((deniedAudit.get(key) ?? 0) > now - 60_000) return;
  deniedAudit.set(key, now);
  sweep(deniedAudit, now - 60_000);
  await writeAudit(
    { db: deps.db, activeOrgId: route.orgId, user: { id: uid } },
    {
      action: 'authz.deny:app.access',
      targetType: route.stack ? 'stack' : 'service',
      targetId: route.stack || route.serviceName,
      metadata: { host: route.host, policyId },
    },
  );
}

function denied(route: ProtectedRoute): AppAuthResponse {
  return page(
    403,
    "You don't have access to this app",
    `<p>You are signed in to swarmy, but <strong>${esc(route.host)}</strong> only admits the people and groups its owners chose.</p><p>Ask an admin of this swarmy organisation to add you under the app's <em>Access</em> tab.</p><p><a href="${APP_AUTH_PATH_PREFIX}/logout">Sign out of this app</a></p>`,
  );
}

/**
 * The forward-auth check. `orgId` comes from the rendered verify URL
 * (`/_app-auth/verify?org=…`); the host must be a login-protected route of
 * that org or the answer is 403 (fail closed — e.g. a toggle just turned
 * off, or a forged Host).
 */
export async function verifyAppRequest(
  deps: AppAccessDeps,
  orgId: string | undefined,
  headers: Headers,
): Promise<AppAuthResponse> {
  const now = (deps.now ?? Date.now)();
  const req = edgeRequestFrom(headers);
  if (!orgId || !req.host) return page(400, 'Bad request', '<p>This check is only reachable through the swarmy edge.</p>');
  const route = findProtectedRoute(deps.hub, orgId, req.host, pathOf(req.uri));
  if (!route) return page(403, 'Not a protected app', '<p>This address is not behind swarmy sign-in.</p>');

  const cookies = parseCookies(req.cookie);
  const raw = cookies.get(APP_COOKIE_SECURE) ?? cookies.get(APP_COOKIE_PLAIN);
  const cookie = openToken<AppCookie>('cookie', raw, now);
  if (!cookie || cookie.host !== req.host || cookie.org !== orgId) return unauthenticated(deps, req, Boolean(raw));

  const cacheKey = `${raw}|${req.host}|${route.stack || route.serviceName}`;
  const hit = decisions.get(cacheKey);
  if (hit && now - hit.at < DECISION_CACHE_MS) return hit.res;

  const who = await liveSession(deps.db, cookie.sid, cookie.uid, now);
  if (!who) return unauthenticated(deps, req, true);
  const d = await decideAccess(deps, route, who.uid);
  if (!d.permit) {
    await auditDenied(deps, route, who.uid, d.policyId);
    return denied(route);
  }
  const jwt = signAppJwt(
    {
      iss: deps.publicUrl,
      sub: who.uid,
      aud: req.host,
      email: who.email,
      name: who.name,
      groups: d.groups,
      org: orgId,
      stack: route.stack || route.serviceName,
    },
    now,
  );
  const res: AppAuthResponse = {
    status: 200,
    headers: {
      'cache-control': 'no-store',
      'X-Swarmy-User': who.uid,
      'X-Swarmy-Email': who.email ?? '',
      'X-Swarmy-Groups': d.groups.join(','),
      'X-Swarmy-Jwt': jwt,
    },
  };
  if (decisions.size > 5000) decisions.clear();
  decisions.set(cacheKey, { at: now, res });
  return res;
}

/** nginx's `@swarmy_login` fallback: the same redirect verify gives Caddy/Traefik. */
export function loginRedirectFromEdge(deps: AppAccessDeps, headers: Headers): AppAuthResponse {
  const req = edgeRequestFrom(headers);
  if (!req.host) return page(400, 'Bad request', '<p>Missing host.</p>');
  return unauthenticated(deps, { ...req, statusMode: false, method: 'GET', accept: 'text/html' }, false);
}

// ── login round trip ─────────────────────────────────────────────────────────

function parseReturnTo(rd: string | undefined): URL | null {
  if (!rd) return null;
  try {
    const u = new URL(rd);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
  } catch {
    return null;
  }
}

/**
 * On the controller's domain, with the swarmy session: find the org whose
 * protected route serves `rd`'s host (only among the caller's own orgs — so
 * this can never mint a code for an arbitrary host), check `app.access`, and
 * hand a one-time code to the app domain's callback.
 */
export async function startAppLogin(
  deps: AppAccessDeps,
  session: { id: string; userId: string; mfaPending?: boolean | null } | null,
  rd: string | undefined,
): Promise<AppAuthResponse> {
  const now = (deps.now ?? Date.now)();
  const target = parseReturnTo(rd);
  if (!target) return page(400, 'Bad request', '<p>Missing or invalid return address.</p>');
  if (!session || session.mfaPending) {
    const back = `/app-login?rd=${encodeURIComponent(target.toString())}`;
    return { status: 302, headers: { location: `/login?redirect=${encodeURIComponent(back)}`, 'cache-control': 'no-store' } };
  }
  const host = stripPort(target.host);
  const memberships = await deps.db.member.findMany({
    where: { userId: session.userId },
    select: { organizationId: true },
  });
  let route: ProtectedRoute | null = null;
  for (const m of memberships) {
    route = findProtectedRoute(deps.hub, m.organizationId, host, target.pathname);
    if (route) break;
  }
  if (!route) {
    return page(404, 'Not a protected app', `<p><strong>${esc(host)}</strong> is not a swarmy app you can sign in to.</p>`);
  }
  const d = await decideAccess(deps, route, session.userId);
  if (!d.permit) {
    await auditDenied(deps, route, session.userId, d.policyId);
    return denied(route);
  }
  const code = sealToken('code', {
    v: 1,
    sid: session.id,
    uid: session.userId,
    host,
    org: route.orgId,
    rd: `${target.pathname}${target.search}` || '/',
    nonce: randomBytes(12).toString('base64url'),
    exp: Math.floor(now / 1000) + LOGIN_CODE_TTL_SECONDS,
  } satisfies AppLoginCode);
  const callback = `${target.protocol}//${target.host}${APP_AUTH_PATH_PREFIX}/callback?code=${encodeURIComponent(code)}`;
  return { status: 302, headers: { location: callback, 'cache-control': 'no-store' } };
}

/**
 * On the APP's domain (edge-mapped `/.swarmy/auth/callback`): redeem the
 * one-time code — host-bound, 60s, single use — and set the first-party app
 * cookie, then land on the page the user asked for.
 */
export async function completeAppLogin(
  deps: AppAccessDeps,
  headers: Headers,
  code: string | undefined,
): Promise<AppAuthResponse> {
  const now = (deps.now ?? Date.now)();
  const req = edgeRequestFrom(headers);
  const c = openToken<AppLoginCode>('code', code, now);
  if (!c || c.host !== req.host) {
    return page(400, 'Sign-in link expired', `<p>That sign-in link is invalid or expired. <a href="/">Try again</a>.</p>`);
  }
  if (usedNonces.has(c.nonce)) {
    return page(400, 'Sign-in link already used', `<p>That sign-in link was already used. <a href="/">Continue</a>.</p>`);
  }
  usedNonces.set(c.nonce, c.exp * 1000);
  sweep(usedNonces, now);
  const who = await liveSession(deps.db, c.sid, c.uid, now);
  if (!who) return page(401, 'Session ended', `<p>Your swarmy session ended. <a href="/">Sign in again</a>.</p>`);
  const exp = Math.min(Math.floor(who.sessionExpiresAt.getTime() / 1000), Math.floor(now / 1000) + APP_COOKIE_MAX_SECONDS);
  const token = sealToken('cookie', { v: 1, sid: c.sid, uid: c.uid, host: c.host, org: c.org, exp } satisfies AppCookie);
  const maxAge = Math.max(0, exp - Math.floor(now / 1000));
  const secure = req.proto === 'https' ? '; Secure' : '';
  const setCookie = `${cookieName(req.proto)}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
  const rd = c.rd.startsWith('/') && !c.rd.startsWith('//') && !c.rd.startsWith(APP_AUTH_PATH_PREFIX) ? c.rd : '/';
  await writeAudit(
    { db: deps.db, activeOrgId: c.org, user: { id: c.uid } },
    { action: 'app.access.login', targetType: 'app', targetId: c.host, metadata: { host: c.host } },
  );
  return { status: 302, headers: { location: rd, 'set-cookie': setCookie, 'cache-control': 'no-store' } };
}

/** `/.swarmy/auth/logout` on the app domain: drop the app cookie (swarmy itself stays signed in). */
export function appLogout(deps: AppAccessDeps, headers: Headers): AppAuthResponse {
  const req = edgeRequestFrom(headers);
  const again = appLoginUrl(deps.publicUrl, `${req.proto}://${req.hostWithPort}/`);
  return page(
    200,
    'Signed out',
    `<p>You are signed out of <strong>${esc(req.host)}</strong>.</p><p><a href="${esc(again)}">Sign in again</a></p>`,
    { 'set-cookie': clearCookies() },
  );
}
