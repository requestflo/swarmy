import { join } from 'node:path';
import type { ServerWebSocket } from 'bun';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import {
  adaptDirectHttpRequest,
  adaptDirectHttpResponse,
  authRegistry,
  directHttpHost,
  parseTrustedProxies,
  resolveClientIp,
  withClientIp,
} from '@swarmy/auth';
import {
  prisma,
  ensureSchema,
  buildAdapter,
  buildTelemetryAdapter,
  resolveDbPaths,
  TELEMETRY_MIGRATIONS_DIR,
} from '@swarmy/db';
import { resolveOrgContextFromApiKey, agentRelease, agentBinaryPath, submitRecoveryClaim, pollRecoveryClaim, writeAudit, acmeDnsRequest, ingressConfigRepo } from '@swarmy/trpc';
import { createRestApp } from '@swarmy/api-rest';
import { createApiTokenVerifier, ensureMcpOidcClient } from '@swarmy/auth';
import { resolveOrgContextFromBearer } from '@swarmy/trpc/devx';
import { createDevxApp } from './devx';
import { env } from './env';
import { maybeBootstrapSeed } from './bootstrap/seed';
import { handleTrpc } from './trpc';
import { resolveControllerPublicUrl } from '@swarmy/core';
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
import { gitCallbackApp } from './git-callback';
import { inboundHooksApp } from './inbound-hooks';
import { statusPublicApp } from './status-public';
import { rumApp } from './rum';
import { aiGatewayApp } from './ai-gateway';
import { oauthApp } from './oauth';
import { versionInfo } from './version';
import { licenseStatus } from './license';
import { checkOnDemand, makeIsGated } from './ingress-ask';

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
      // Custom-domain DNS gate: routed-but-unverified hosts are denied too.
      isGated: makeIsGated(async (orgId) => (await ingressConfigRepo.get({ db: prisma, hub }, orgId)).settings),
    },
    c.req.query('domain'),
  );
  return c.text(body, status as 200 | 400 | 403);
});

// ACME DNS-01 for wildcard certificates: the edge's `dns swarmy` provider asks
// us to publish `_acme-challenge` TXT on swarmy-dns (the org's own nameservers).
// Bearer-gated per org (HMAC-derived token mounted on the edge as a Docker
// secret); only names the org routes inside its own zones are accepted.
app.post('/ingress/acme-dns/:orgId/:action', async (c) => {
  const body = await c.req.json().catch(() => null);
  const { status, body: text } = await acmeDnsRequest(
    { db: prisma, hub, auth: authRegistry.getAuth() },
    {
      orgId: c.req.param('orgId'),
      action: c.req.param('action'),
      authorization: c.req.header('authorization'),
      body,
    },
  );
  return c.text(text, status);
});

// Live node installer: curl -fsSL <controller>/install.sh | SWARMY_JOIN_TOKEN=… sh
// Optional ?manager=1 adds a swarm-manager init hint for the first node.
app.get('/install.sh', (c) => {
  const manager = c.req.query('manager') === '1';
  return c.body(renderInstallScript(requestControllerUrl(c.req.raw.headers), { manager }), 200, {
    'content-type': 'text/x-shellscript; charset=utf-8',
    'cache-control': 'no-store',
  });
});

// node-onboarding P2: two-stage, checksum-pinned installer.
//   GET /install/loader.sh           → tiny loader (verifies + execs the installer)
//   GET /install/:version/install.sh        → the real (big) installer
//   GET /install/:version/install.sh.sha256 → its checksum (for manual verify)
/**
 * The controller base URL to bake into install scripts for THIS request:
 * CONTROLLER_PUBLIC_URL when it's a real address, else the address the
 * request reached us at (X-Forwarded-* › Origin › Host). Sanitised — it lands
 * in a shell body. (issue: install-repair-one-liner-broken-when-controller-not-self-reachable)
 */
function requestControllerUrl(headers: Headers): string {
  return resolveControllerPublicUrl({ configured: process.env.CONTROLLER_PUBLIC_URL, headers }).url;
}

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
  // Deliberately request-INDEPENDENT: the loader pins this body's sha256, so
  // it must render identically whichever address fetched it. The loader
  // exports SWARMY_CONTROLLER_URL/SWARMY_BINARY_BASE_URL, so these baked
  // defaults only matter for a direct install.sh run without --controller.
  return {
    controllerUrl: env.CONTROLLER_PUBLIC_URL,
    version,
    agentImage: env.AGENT_IMAGE,
    binaryBaseUrl: env.AGENT_BINARY_BASE_URL,
    binarySha256,
    binaryBaseFromController: env.AGENT_BINARY_BASE_URL_EXPLICIT == null,
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
      controllerUrl: requestControllerUrl(c.req.raw.headers),
      version,
      installerSha256: sha256Hex(installerBody),
      binaryBaseUrl: env.AGENT_BINARY_BASE_URL_EXPLICIT ?? undefined,
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

// Recovery beacon (self-healing epic): a node that lost every credential
// posts a claim here and polls for the operator's approval. Deliberately
// unauthenticated — see recovery.service.ts for the trust model (fingerprint
// comparison, existing-nodes-only, claim-secret binding, one-shot delivery).
app.post('/agent/recovery/claim', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { hostname?: string; claimHash?: string } | null;
  if (!body?.hostname || !body.claimHash) return c.json({ accepted: false }, 400);
  const result = await submitRecoveryClaim(prisma, { hostname: body.hostname, claimHash: body.claimHash });
  return c.json(result, 202);
});
app.post('/agent/recovery/poll', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { claimId?: string; claimSecret?: string } | null;
  if (!body?.claimId || !body.claimSecret) return c.json({ status: 'unknown' }, 400);
  const result = await pollRecoveryClaim(prisma, { claimId: body.claimId, claimSecret: body.claimSecret });
  return c.json(result, 200, { 'cache-control': 'no-store' });
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
// swarmy's OIDC provider: RFC 8414 metadata lives at the root with the issuer
// path appended (OIDC discovery is under /api/auth, handled above).
app.get('/.well-known/oauth-authorization-server/api/auth', (c) => authRegistry.getAuth().handler(c.req.raw));
app.all('/api/trpc/*', (c) => handleTrpc(c.req.raw));

// Public REST API (OpenAPI) — handlers reuse the tRPC service layer via a
// bearer-resolved OrgContext: an `swk_…` API key, or an OAuth access token
// swarmy's OIDC provider issued for its own APIs (MCP clients).
const verifyAccessToken = createApiTokenVerifier(() => authRegistry.getAuth());
const resolveBearer = (presented: string) =>
  resolveOrgContextFromBearer({ db: prisma, hub, auth: authRegistry.getAuth(), verifyAccessToken }, presented);
const restApp = createRestApp({ resolveContextFromApiKey: resolveBearer });
app.route('/api/v1', restApp);

// Developer CLI + MCP (developer-platform §4): `swarmy login` device flow,
// CLI binaries at /install/cli/*, and the MCP server at /mcp (+ its RFC 9728
// metadata). /mcp calls the REST API in-process with the caller's bearer.
app.route('/', createDevxApp({ appFetch: (req) => app.fetch(req), resolveBearer }));

// Git provider webhooks (push → build). Public, per-repo HMAC-verified.
app.route('/webhooks', webhooksApp);

// Git provider OAuth / GitHub App redirect targets (no session — signed state).
app.route('/git', gitCallbackApp);

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

// Web analytics + session replay ingest: the edge maps /_swarmy/* on every
// RUM-enabled app domain here (first-party to the browser). Public, capped.
app.route('/_rum', rumApp);

// ── Dashboard SPA (self-host single-image) ──────────────────────────────────
// In production the controller image bundles the built dashboard and serves it
// same-origin: the SPA calls /api/trpc + /api/auth and upgrades /agent + /term on
// this very origin. SWARMY_STATIC_DIR points at the built assets (the image sets
// it to ./public). It is unset in dev — Vite serves :3023 and proxies back here —
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
      p === '/mcp' ||
      p.startsWith('/.well-known/oauth-protected-resource') ||
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

// ── Store bring-up ──────────────────────────────────────────────────────────
// The controller's store is two SQLite files in SWARMY_DATA_DIR (control.db,
// telemetry.db), often empty on first boot. Apply pending migrations in-process
// BEFORE anything reads the DB: authRegistry.rebuild() below is the first read.
{
  const paths = resolveDbPaths();
  const applied = [
    ...(await ensureSchema(buildAdapter())),
    ...(await ensureSchema(buildTelemetryAdapter(), TELEMETRY_MIGRATIONS_DIR)).map((m) => `telemetry/${m}`),
  ];
  // eslint-disable-next-line no-console
  console.log(
    `swarmy controller: store ${paths.control}` +
      (applied.length > 0 ? `; applied ${applied.length} migration(s): ${applied.join(', ')}` : ''),
  );
}

// Sign-in provisioning (invite links, SSO JIT membership + group sync) audits
// through the one audit writer.
authRegistry.configure({
  audit: (orgId, entry) => writeAudit({ db: prisma, activeOrgId: orgId, user: null }, entry),
});
// Load stored auth-provider config so social/SSO providers are live without a restart.
await authRegistry.rebuild();
// The pre-registered public OAuth client MCP hosts sign in with (idempotent).
await ensureMcpOidcClient(prisma).catch((e: unknown) => {
  // eslint-disable-next-line no-console
  console.warn('swarmy controller: could not register the MCP OAuth client:', e);
});

// Self-host first-boot: seed the owner org/user and the bootstrap join token, and
// prime the in-memory swarm join cache (so added nodes join this swarm). Gated on SWARMY_BOOTSTRAP=1 and
// idempotent — inert in dev and harmless on every restart.
await maybeBootstrapSeed();

type WsData = AgentWsData | TermWsData;

function isTerm(ws: ServerWebSocket<WsData>): ws is TermSocket {
  return 'kind' in ws.data && (ws.data as { kind?: string }).kind === 'term';
}

// Client IP for Better Auth's per-IP rate limiter + Session.ipAddress (and any
// handler that reads it). Derived from the TCP peer; X-Forwarded-For is honoured
// only when that peer is in SWARMY_TRUSTED_PROXIES (default: loopback). The
// installer publishes :3021 in host mode, so a direct hit's peer IS the client
// (no routing-mesh SNAT). Trust model: packages/auth/src/client-ip.ts.
const trustedProxies = parseTrustedProxies();
if (trustedProxies.invalid.length > 0) {
  // eslint-disable-next-line no-console
  console.warn(`swarmy controller: ignoring invalid SWARMY_TRUSTED_PROXIES entries: ${trustedProxies.invalid.join(', ')}`);
}

// https dashboard domain + direct http://<ip>:3021: translate auth cookies on
// the plain-http origin so both keep a working session (@swarmy/auth origins.ts).
const directHost = directHttpHost();
const cookiePrefix = process.env.SWARMY_AUTH_COOKIE_PREFIX ?? 'swarmy';

const server = Bun.serve<WsData>({
  port: env.PORT,
  idleTimeout: 60,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === '/agent/ws') {
      const sourceIp = resolveClientIp(srv.requestIP(req)?.address, req.headers, trustedProxies) ?? undefined;
      const upgraded = srv.upgrade(req, {
        data: { state: 'await_register', openedAt: Date.now(), sourceIp } satisfies AgentWsData,
      });
      return upgraded ? undefined : new Response('websocket upgrade failed', { status: 400 });
    }
    if (url.pathname === '/term/ws') {
      const data = await authorizeTermUpgrade(adaptDirectHttpRequest(req, directHost, cookiePrefix));
      if (!data) return new Response('unauthorized', { status: 401 });
      const upgraded = srv.upgrade(req, { data });
      return upgraded ? undefined : new Response('websocket upgrade failed', { status: 400 });
    }
    const authReq = adaptDirectHttpRequest(req, directHost, cookiePrefix);
    const res = await app.fetch(withClientIp(authReq, srv.requestIP(req)?.address, trustedProxies));
    return adaptDirectHttpResponse(req, res, directHost);
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
