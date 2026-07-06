import { join } from 'node:path';
import type { ServerWebSocket } from 'bun';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { authRegistry } from '@swarmy/auth';
import { prisma, ensureSchema, buildAdapter, resolveDbDriver } from '@swarmy/db';
import { resolveOrgContextFromApiKey, agentRelease, agentBinaryPath } from '@swarmy/trpc';
import { createRestApp } from '@swarmy/api-rest';
import { env } from './env';
import { maybeBootstrapSeed } from './bootstrap/seed';
import { handleTrpc } from './trpc';
import { renderInstallScript } from './install-script';
import { renderLoader, renderChecksumFile, sha256Hex } from './install/loader';
import { renderInstaller, type RenderInstallerOptions } from './install/installer';
import { agentWebSocketHandlers, hub, type AgentWsData } from './gateway';
import { activatorApp } from './activator';
import {
  authorizeTermUpgrade,
  terminalWebSocketHandlers,
  type TermWsData,
  type TermSocket,
} from './terminal';
import { startWorkers } from './workers';
import { webhooksApp } from './webhooks';
import { inboundHooksApp } from './inbound-hooks';
import { statusPublicApp } from './status-public';
import { aiGatewayApp } from './ai-gateway';
import { oauthApp } from './oauth';
import { versionInfo } from './version';
import { licenseStatus } from './license';
import { checkOnDemand } from './ingress-ask';

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true, service: 'swarmy-controller' }));
app.get('/version', (c) => c.json({ ...versionInfo(), enterprise: licenseStatus().enabled }));

// Caddy on-demand-TLS gate: 200 only for known org domains. Public, read-only.
app.get('/ingress/ask', async (c) => {
  // Routes live on swarmy.ingress.routes service labels now (no Domain model) —
  // scan every org's live inventory for the host.
  const { status, body } = await checkOnDemand(
    {
      listOrgIds: () => prisma.organization.findMany({ select: { id: true } }).then((rows) => rows.map((r) => r.id)),
      liveInventory: (orgId) => hub.liveInventory(orgId),
    },
    c.req.query('domain'),
  );
  return c.text(body, status as 200 | 400 | 403);
});

// Live node installer: curl -fsSL <controller>/install.sh | SWARMY_JOIN_TOKEN=… sh
// Optional ?manager=1 adds a swarm-manager init hint for the first node.
app.get('/install.sh', (c) => {
  const manager = c.req.query('manager') === '1';
  return c.body(renderInstallScript(env.CONTROLLER_PUBLIC_URL, { manager }), 200, {
    'content-type': 'text/x-shellscript; charset=utf-8',
    'cache-control': 'no-store',
  });
});

// node-onboarding P2: two-stage, checksum-pinned installer.
//   GET /install/loader.sh           → tiny loader (verifies + execs the installer)
//   GET /install/:version/install.sh        → the real (big) installer
//   GET /install/:version/install.sh.sha256 → its checksum (for manual verify)
function installerOptionsFor(version: string): RenderInstallerOptions {
  // Checksums: explicit env pin wins; otherwise the manifest of the binaries
  // this controller itself serves at /install/bin/<platform>.
  let binarySha256: Record<string, string> = {};
  try {
    binarySha256 = JSON.parse(env.AGENT_BINARY_SHA256) as Record<string, string>;
  } catch {
    binarySha256 = {};
  }
  if (Object.keys(binarySha256).length === 0) {
    const release = agentRelease();
    if (release) {
      binarySha256 = Object.fromEntries(
        Object.entries(release.platforms).map(([platform, meta]) => [platform, meta.sha256]),
      );
    }
  }
  return {
    controllerUrl: env.CONTROLLER_PUBLIC_URL,
    version,
    agentImage: env.AGENT_IMAGE,
    binaryBaseUrl: env.AGENT_BINARY_BASE_URL,
    binarySha256,
  };
}

/** The installer's pinned version: env override, else the built manifest's. */
function agentReleaseVersion(): string {
  return env.AGENT_VERSION !== 'latest' ? env.AGENT_VERSION : (agentRelease()?.version ?? env.AGENT_VERSION);
}

app.get('/install/loader.sh', (c) => {
  const version = c.req.query('version') ?? agentReleaseVersion();
  const installerBody = renderInstaller(installerOptionsFor(version));
  return c.body(
    renderLoader({
      controllerUrl: env.CONTROLLER_PUBLIC_URL,
      version,
      installerSha256: sha256Hex(installerBody),
    }),
    200,
    { 'content-type': 'text/x-shellscript; charset=utf-8', 'cache-control': 'no-store' },
  );
});

app.get('/install/:version/install.sh', (c) => {
  const version = c.req.param('version');
  return c.body(renderInstaller(installerOptionsFor(version)), 200, {
    'content-type': 'text/x-shellscript; charset=utf-8',
    'cache-control': 'public, max-age=300',
  });
});

app.get('/install/:version/install.sh.sha256', (c) => {
  const version = c.req.param('version');
  return c.body(renderChecksumFile(renderInstaller(installerOptionsFor(version))), 200, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'public, max-age=300',
  });
});

// Compiled agent binaries, served by the controller itself (self-hosted end to
// end — no external release CDN in the install or self-update path). The
// installer and the updateAgent command both verify the sha256 pinned above.
app.get('/install/bin/manifest.json', (c) => {
  const release = agentRelease();
  if (!release) return c.text('no agent binaries built on this controller', 404);
  return c.json(release, 200, { 'cache-control': 'no-store' });
});

// A single catch-all for `<platform>` and `<platform>.sha256` — a regex-param
// with a literal `.sha256` suffix doesn't match reliably in Hono's router, so
// capture the whole filename (dots allowed) and branch here.
app.get('/install/bin/:file{[a-z0-9.-]+}', (c) => {
  const file = c.req.param('file');
  const checksum = file.endsWith('.sha256');
  const platform = checksum ? file.slice(0, -'.sha256'.length) : file;

  if (checksum) {
    const meta = agentRelease()?.platforms[platform];
    if (!meta) return c.text(`no agent binary for platform ${platform}`, 404);
    return c.text(`${meta.sha256}  swarmy-agent-${platform}\n`, 200, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    });
  }

  const binPath = agentBinaryPath(platform);
  if (!binPath) return c.text(`no agent binary for platform ${platform}`, 404);
  return new Response(Bun.file(binPath), {
    headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="swarmy-agent-${platform}"`,
      'cache-control': 'no-store',
    },
  });
});
app.on(['GET', 'POST'], '/api/auth/*', (c) => authRegistry.getAuth().handler(c.req.raw));
app.all('/api/trpc/*', (c) => handleTrpc(c.req.raw));

// Public REST API (OpenAPI) — handlers reuse the tRPC service layer via an
// api-key-resolved OrgContext.
const restApp = createRestApp({
  resolveContextFromApiKey: (presentedKey) =>
    resolveOrgContextFromApiKey({ db: prisma, hub, auth: authRegistry.getAuth() }, presentedKey),
});
app.route('/api/v1', restApp);

// Git provider webhooks (push → build). Public, per-repo HMAC-verified.
app.route('/webhooks', webhooksApp);

// Inbound webhook gateway (B4): public third-party webhook receiver.
app.route('/hooks', inboundHooksApp);

// Public status pages (C5): unauthenticated JSON snapshots.
app.route('/status', statusPublicApp);

// AI gateway (F5): provider-shaped proxy authed by virtual keys.
app.route('/ai', aiGatewayApp);

// OAuth2 client-credentials token endpoint (public-api-terraform P2). Public.
app.route('/oauth', oauthApp);

// Scale-to-zero activator (epic #4B): wake a cold service on the first request.
app.route('/_wake', activatorApp);

// ── Dashboard SPA (self-host single-image) ──────────────────────────────────
// In production the controller image bundles the built dashboard and serves it
// same-origin: the SPA calls /api/trpc + /api/auth and upgrades /agent + /term on
// this very origin. SWARMY_STATIC_DIR points at the built assets (the image sets
// it to ./public). It is unset in dev — Vite serves :3003 and proxies back here —
// so this whole block is inert locally. Mounted AFTER every functional route so
// those win, and the SPA fallback below preserves JSON 404s for API namespaces.
const STATIC_DIR = process.env.SWARMY_STATIC_DIR;
if (STATIC_DIR) {
  const indexHtmlPath = join(STATIC_DIR, 'index.html');
  app.use('/assets/*', serveStatic({ root: STATIC_DIR }));
  app.use('*', serveStatic({ root: STATIC_DIR }));
  // SPA fallback: client-routed paths (e.g. /infrastructure) resolve to index.html;
  // unmatched API/functional paths keep a real JSON 404 instead of the HTML shell.
  app.get('*', async (c) => {
    const p = c.req.path;
    if (
      p.startsWith('/api') ||
      // trailing slash: the bare SPA route `/webhooks` must fall through to
      // index.html; only the git-webhook API namespace 404s as JSON.
      p.startsWith('/webhooks/') ||
      p.startsWith('/hooks') ||
      // `/status/*` is the public status-page JSON namespace; the bare SPA
      // routes `/status-pages` and `/ai` must still fall through to index.html.
      p.startsWith('/status/') ||
      p.startsWith('/ai/v1') ||
      p.startsWith('/oauth') ||
      p.startsWith('/_wake') ||
      p.startsWith('/install') ||
      p === '/health' ||
      p === '/version'
    ) {
      return c.json({ error: 'not found' }, 404);
    }
    const file = Bun.file(indexHtmlPath);
    if (await file.exists()) return c.html(await file.text());
    return c.json({ error: 'not found' }, 404);
  });
}

app.notFound((c) => c.json({ error: 'not found' }, 404));

// ── Fresh-DB bring-up (self-host) ───────────────────────────────────────────
// A self-hosted controller boots against an empty database. Lite (PGlite) mode
// has no external `prisma migrate deploy`, so apply pending migrations in-process
// BEFORE anything reads the DB — authRegistry.rebuild() below is the first read
// and it throws on a table-less DB. Gated so dev's `bun db:push` flow (which never
// records into _swarmy_migrations) is not double-applied: lite always self-migrates;
// managed Postgres opts in via SWARMY_SELF_MIGRATE=1 (set by the self-host stack),
// leaving `prisma migrate deploy` as the path for externally-managed databases.
if (resolveDbDriver() === 'pglite' || process.env.SWARMY_SELF_MIGRATE === '1') {
  const applied = await ensureSchema(buildAdapter() as never);
  if (applied.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`swarmy controller: applied ${applied.length} migration(s): ${applied.join(', ')}`);
  }
}

// Load stored auth-provider config so social/SSO providers are live without a restart.
await authRegistry.rebuild();

// Self-host first-boot: seed the owner org/user, the bootstrap join token, and the
// SwarmConfig (so added nodes join this swarm). Gated on SWARMY_BOOTSTRAP=1 and
// idempotent — inert in dev and harmless on every restart.
await maybeBootstrapSeed();

type WsData = AgentWsData | TermWsData;

function isTerm(ws: ServerWebSocket<WsData>): ws is TermSocket {
  return 'kind' in ws.data && (ws.data as { kind?: string }).kind === 'term';
}

const server = Bun.serve<WsData>({
  port: env.PORT,
  idleTimeout: 60,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === '/agent/ws') {
      const upgraded = srv.upgrade(req, {
        data: { state: 'await_register', openedAt: Date.now() } satisfies AgentWsData,
      });
      return upgraded ? undefined : new Response('websocket upgrade failed', { status: 400 });
    }
    if (url.pathname === '/term/ws') {
      const data = await authorizeTermUpgrade(req);
      if (!data) return new Response('unauthorized', { status: 401 });
      const upgraded = srv.upgrade(req, { data });
      return upgraded ? undefined : new Response('websocket upgrade failed', { status: 400 });
    }
    return app.fetch(req);
  },
  websocket: {
    open(ws) {
      if (isTerm(ws)) terminalWebSocketHandlers.open(ws);
      else agentWebSocketHandlers.open(ws as never);
    },
    message(ws, message) {
      if (isTerm(ws)) terminalWebSocketHandlers.message(ws, message);
      else void agentWebSocketHandlers.message(ws as never, message);
    },
    close(ws) {
      if (isTerm(ws)) void terminalWebSocketHandlers.close(ws);
      else void agentWebSocketHandlers.close(ws as never);
    },
  },
});

startWorkers();
// eslint-disable-next-line no-console
console.log(`swarmy controller listening on http://localhost:${server.port}`);
