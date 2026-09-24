import { Hono, type Context } from 'hono';
import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { resolveControllerPublicUrl } from '@swarmy/core';
import {
  appJwks,
  appLogout,
  completeAppLogin,
  loginRedirectFromEdge,
  startAppLogin,
  verifyAppRequest,
  type AppAccessDeps,
  type AppAuthResponse,
} from '@swarmy/trpc';
import { env } from './env';
import { hub } from './gateway';

/**
 * "Protect my app" HTTP surface (dev-platform §2A). The logic lives in
 * `@swarmy/trpc` app-access.service; this only adapts Hono ⇄ the service.
 *
 *   GET /_app-auth/verify?org=…   edge forward-auth subrequest (Caddy/Traefik/nginx)
 *   GET /_app-auth/login          nginx's 401 fallback → the login redirect
 *   GET /_app-auth/start?rd=…     controller domain: swarmy session → one-time code
 *   GET /_app-auth/callback?code= app domain (edge-mapped /.swarmy/auth/callback)
 *   GET /_app-auth/logout         app domain (edge-mapped /.swarmy/auth/logout)
 *   GET /.well-known/swarmy-jwks.json   public keys for X-Swarmy-Jwt
 */

/**
 * Where people sign in: the dashboard origin. `SWARMY_DASHBOARD_URL` wins
 * (dev: the Vite app on :3023), else the controller's public URL — never the
 * request's own headers, since /verify is called with the APP's Host.
 */
function publicUrl(): string {
  const explicit = process.env.SWARMY_DASHBOARD_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  return resolveControllerPublicUrl({ configured: env.CONTROLLER_PUBLIC_URL }).url.replace(/\/+$/, '');
}

export function appAccessDeps(): AppAccessDeps {
  return { db: prisma, hub, publicUrl: publicUrl() };
}

function send(c: Context, r: AppAuthResponse): Response {
  const headers = new Headers();
  for (const [k, v] of Object.entries(r.headers)) {
    if (Array.isArray(v)) for (const x of v) headers.append(k, x);
    else headers.set(k, v);
  }
  return new Response(r.body ?? null, { status: r.status, headers });
}

export const appAuthApp = new Hono();

appAuthApp.get('/verify', async (c) => send(c, await verifyAppRequest(appAccessDeps(), c.req.query('org'), c.req.raw.headers)));
appAuthApp.get('/login', (c) => send(c, loginRedirectFromEdge(appAccessDeps(), c.req.raw.headers)));
appAuthApp.get('/start', async (c) => {
  const data = await authRegistry
    .getAuth()
    .api.getSession({ headers: c.req.raw.headers })
    .catch(() => null);
  const s = data?.session as { id: string; userId: string; mfaPending?: boolean | null } | undefined;
  return send(c, await startAppLogin(appAccessDeps(), s ?? null, c.req.query('rd')));
});
appAuthApp.get('/callback', async (c) => send(c, await completeAppLogin(appAccessDeps(), c.req.raw.headers, c.req.query('code'))));
appAuthApp.get('/logout', (c) => send(c, appLogout(appAccessDeps(), c.req.raw.headers)));

export function appJwksResponse(): Response {
  return new Response(JSON.stringify(appJwks()), {
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
  });
}
