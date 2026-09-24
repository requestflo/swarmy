/**
 * swarmy-app-auth — the per-app Better Auth service swarmy deploys for
 * `auth:` in swarmy.yaml (dev-platform §2B). One replica per app, routed at
 * `/auth/*` on the app's own domains, so every cookie is first-party.
 *
 *   /auth/*                      Better Auth (social, generic OIDC, magic link,
 *                                password; /auth/jwks + /auth/token from the
 *                                jwt plugin — what @swarmy/app-auth verifies)
 *   /auth/login, /auth/logout    hosted pages (an app needs no UI code)
 *   /auth/swarmy/providers       enabled providers + email mode (client helper)
 *   /auth/swarmy/admin/*         users list / disable / enable — ONLY with a
 *                                short-lived admin JWT signed by the swarmy
 *                                controller (verified against its JWKS)
 *
 * Storage: its own SQLite file on a volume, or the app's managed Postgres
 * (DATABASE_URL). The auth secret is `/run/secrets/auth-secret` when present,
 * else generated once and kept in the same database.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { Pool } from 'pg';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { admin, genericOAuth, jwt, magicLink } from 'better-auth/plugins';
import { getMigrations } from 'better-auth/db/migration';
import { emailAllowed, loadConfig, trustedOrigins, type AuthServiceConfig } from './config';
import { remoteJwks, verifyWithJwks, type RemoteJwks } from './jwt';
import { hostedLoginPage, hostedLogoutPage } from './pages';

type Db = { kind: 'sqlite'; sqlite: Database } | { kind: 'postgres'; pool: Pool };

function openDb(cfg: AuthServiceConfig): Db {
  if (cfg.database.kind === 'postgres') return { kind: 'postgres', pool: new Pool({ connectionString: cfg.database.url, max: 5 }) };
  mkdirSync(dirname(cfg.database.path), { recursive: true });
  const sqlite = new Database(cfg.database.path, { create: true });
  sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  return { kind: 'sqlite', sqlite };
}

/** The auth secret: a Docker secret if mounted, else generated once and persisted with the users. */
async function authSecret(cfg: AuthServiceConfig, db: Db): Promise<string> {
  const file = Bun.file(`${cfg.secretsDir}/auth-secret`);
  if (await file.exists()) return (await file.text()).trim();
  const fresh = randomBytes(32).toString('base64url');
  if (db.kind === 'sqlite') {
    db.sqlite.exec('CREATE TABLE IF NOT EXISTS swarmy_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    db.sqlite.query('INSERT OR IGNORE INTO swarmy_meta (k, v) VALUES (?, ?)').run('auth_secret', fresh);
    return (db.sqlite.query('SELECT v FROM swarmy_meta WHERE k = ?').get('auth_secret') as { v: string }).v;
  }
  await db.pool.query('CREATE TABLE IF NOT EXISTS swarmy_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  await db.pool.query('INSERT INTO swarmy_meta (k, v) VALUES ($1, $2) ON CONFLICT (k) DO NOTHING', ['auth_secret', fresh]);
  const r = await db.pool.query<{ v: string }>('SELECT v FROM swarmy_meta WHERE k = $1', ['auth_secret']);
  return r.rows[0]!.v;
}

async function sendEmail(cfg: AuthServiceConfig, msg: { to: string; subject: string; text: string; url: string }): Promise<void> {
  if (cfg.emailWebhook) {
    const res = await fetch(cfg.emailWebhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg) });
    if (!res.ok) throw new Error(`email webhook answered ${res.status}`);
    return;
  }
  // No delivery configured yet (swarmy's email service will plug in here):
  // the link lands in the service log so an operator can still hand it over.
  console.log(`[swarmy-app-auth] sign-in link for ${msg.to}: ${msg.url}`);
}

export function authOptions(cfg: AuthServiceConfig, database: BetterAuthOptions['database'], secret: string): BetterAuthOptions {
  const p = cfg.providers;
  const plugins: NonNullable<BetterAuthOptions['plugins']> = [
    jwt({
      jwt: {
        issuer: cfg.appUrl,
        audience: cfg.appUrl,
        expirationTime: '15m',
        definePayload: ({ user }) => ({ email: user.email, name: user.name, groups: [] }),
      },
    }),
    admin(),
  ];
  if (cfg.email === 'magic-link') {
    plugins.push(
      magicLink({
        sendMagicLink: ({ email, url }) =>
          sendEmail(cfg, { to: email, subject: 'Your sign-in link', text: `Sign in: ${url}\n\nThe link expires in 5 minutes.`, url }),
      }),
    );
  }
  if (p.oidc && cfg.oidc) {
    plugins.push(
      genericOAuth({
        config: [
          {
            providerId: 'oidc',
            clientId: p.oidc.clientId,
            clientSecret: p.oidc.clientSecret,
            discoveryUrl: `${cfg.oidc.issuer}/.well-known/openid-configuration`,
            scopes: ['openid', 'email', 'profile'],
            pkce: true,
          },
        ],
      }),
    );
  }
  return {
    appName: cfg.stack,
    baseURL: cfg.appUrl,
    basePath: cfg.basePath,
    secret,
    database,
    trustedOrigins: trustedOrigins(cfg),
    emailAndPassword: { enabled: cfg.email === 'password' },
    socialProviders: {
      ...(p.google ? { google: { clientId: p.google.clientId, clientSecret: p.google.clientSecret } } : {}),
      ...(p.github ? { github: { clientId: p.github.clientId, clientSecret: p.github.clientSecret } } : {}),
      ...(p.microsoft
        ? { microsoft: { clientId: p.microsoft.clientId, clientSecret: p.microsoft.clientSecret, tenantId: cfg.microsoftTenant ?? 'common' } }
        : {}),
    },
    plugins,
    // Always behind the swarmy edge, which sets X-Forwarded-For.
    advanced: { cookiePrefix: 'swarmy-auth', ipAddress: { ipAddressHeaders: ['x-forwarded-for'] } },
    databaseHooks: {
      user: {
        create: {
          // allowedDomains: only these email domains may sign up (any method).
          before: async (user) => (emailAllowed(cfg, user.email) ? { data: user } : false),
        },
      },
    },
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function createServer(cfg: AuthServiceConfig = loadConfig()) {
  const db = openDb(cfg);
  const secret = await authSecret(cfg, db);
  const options = authOptions(cfg, db.kind === 'sqlite' ? db.sqlite : db.pool, secret);
  const { runMigrations } = await getMigrations(options);
  await runMigrations();
  const auth = betterAuth(options);
  const base = cfg.basePath;
  const enabled = Object.keys(cfg.providers).sort();
  for (const m of cfg.missing) {
    console.warn(`[swarmy-app-auth] provider ${m} is listed but its secrets auth-${m}-client-id / auth-${m}-client-secret are missing — disabled`);
  }

  let jwks: RemoteJwks[] | null = null;
  const adminAud = `swarmy-app-auth:${cfg.stack}`;
  /** An admin call must carry a controller-signed JWT for THIS app's stack. */
  async function isAdmin(req: Request): Promise<boolean> {
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
    if (!token) return false;
    jwks ??= cfg.jwksUrls.map((u) => remoteJwks(u));
    for (const set of jwks) {
      try {
        const claims = await verifyWithJwks(token, set, { audience: adminAud });
        if (claims.scope === 'app-auth:admin') return true;
      } catch {
        /* next candidate */
      }
    }
    return false;
  }

  async function adminRoute(req: Request, path: string): Promise<Response> {
    if (!(await isAdmin(req))) return json({ error: 'forbidden' }, 403);
    const ctx = await auth.$context;
    const ia = ctx.internalAdapter;
    if (req.method === 'GET' && path === '/users') {
      const url = new URL(req.url);
      const limit = Math.min(200, Number(url.searchParams.get('limit') ?? 100) || 100);
      const offset = Number(url.searchParams.get('offset') ?? 0) || 0;
      const users = await ia.listUsers(limit, offset, { field: 'createdAt', direction: 'desc' });
      const total = await ia.countTotalUsers();
      return json({
        total,
        users: users.map((u) => {
          const x = u as typeof u & { banned?: boolean | null };
          return { id: u.id, email: u.email, name: u.name, createdAt: u.createdAt, emailVerified: u.emailVerified, disabled: Boolean(x.banned) };
        }),
        providers: enabled,
        email: cfg.email,
      });
    }
    const m = /^\/users\/([^/]+)\/(disable|enable)$/.exec(path);
    if (req.method === 'POST' && m) {
      const id = decodeURIComponent(m[1]!);
      const disable = m[2] === 'disable';
      const user = await ia.findUserById(id);
      if (!user) return json({ error: 'not found' }, 404);
      await ia.updateUser(id, disable ? { banned: true, banReason: 'Disabled in swarmy' } : { banned: false, banReason: null });
      if (disable) await ia.deleteUserSessions(id);
      return json({ id, disabled: disable });
    }
    return json({ error: 'not found' }, 404);
  }

  async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === '/healthz' || path === `${base}/healthz`) return json({ ok: true });
    if (!path.startsWith(`${base}/`) && path !== base) return json({ error: 'not found' }, 404);
    const sub = path.slice(base.length) || '/';
    if (sub === '/swarmy/providers') return json({ providers: enabled, email: cfg.email });
    if (sub.startsWith('/swarmy/admin/')) return adminRoute(req, sub.slice('/swarmy/admin'.length));
    if (req.method === 'GET' && sub === '/login') {
      return new Response(hostedLoginPage({ base, providers: enabled, email: cfg.email, appName: cfg.stack, oidcName: cfg.oidc?.name }), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    if (req.method === 'GET' && sub === '/logout') {
      return new Response(hostedLogoutPage(base), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    return auth.handler(req);
  }

  return { fetch, auth, config: cfg };
}

if (import.meta.main) {
  const cfg = loadConfig();
  const srv = await createServer(cfg);
  Bun.serve({ port: cfg.port, hostname: '0.0.0.0', fetch: srv.fetch });
  console.log(
    `[swarmy-app-auth] ${cfg.stack}: listening on :${cfg.port}${cfg.basePath} (${cfg.database.kind}; providers: ${Object.keys(cfg.providers).join(', ') || 'none'}; email: ${cfg.email})`,
  );
}
