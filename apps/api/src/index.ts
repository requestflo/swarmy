import type { ServerWebSocket } from 'bun';
import { Hono } from 'hono';
import { authRegistry } from '@swarmy/auth';
import { prisma } from '@swarmy/db';
import { resolveOrgContextFromApiKey } from '@swarmy/trpc';
import { createRestApp } from '@swarmy/api-rest';
import { env } from './env';
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
import { oauthApp } from './oauth';
import { versionInfo } from './version';
import { licenseStatus } from './license';
import { checkOnDemand } from './ingress-ask';

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true, service: 'swarmy-controller' }));
app.get('/version', (c) => c.json({ ...versionInfo(), enterprise: licenseStatus().enabled }));

// Caddy on-demand-TLS gate: 200 only for known org domains. Public, read-only.
app.get('/ingress/ask', async (c) => {
  const { status, body } = await checkOnDemand(prisma, c.req.query('domain'));
  return c.text(body, status as 200 | 404 | 400);
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
  let binarySha256: Record<string, string> = {};
  try {
    binarySha256 = JSON.parse(env.AGENT_BINARY_SHA256) as Record<string, string>;
  } catch {
    binarySha256 = {};
  }
  return {
    controllerUrl: env.CONTROLLER_PUBLIC_URL,
    version,
    agentImage: env.AGENT_IMAGE,
    binaryBaseUrl: env.AGENT_BINARY_BASE_URL,
    binarySha256,
  };
}

app.get('/install/loader.sh', (c) => {
  const version = c.req.query('version') ?? env.AGENT_VERSION;
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

// OAuth2 client-credentials token endpoint (public-api-terraform P2). Public.
app.route('/oauth', oauthApp);

// Scale-to-zero activator (epic #4B): wake a cold service on the first request.
app.route('/_wake', activatorApp);

app.notFound((c) => c.json({ error: 'not found' }, 404));

// Load stored auth-provider config so social/SSO providers are live without a restart.
await authRegistry.rebuild();

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
