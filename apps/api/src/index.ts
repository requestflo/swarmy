import { Hono } from 'hono';
import { auth } from '@swarmy/auth';
import { env } from './env';
import { handleTrpc } from './trpc';
import { renderInstallScript } from './install-script';
import { agentWebSocketHandlers, type AgentWsData } from './gateway';
import { startWorkers } from './workers';

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true, service: 'swarmy-controller' }));

// Live node installer: curl -fsSL <controller>/install.sh | SWARMY_JOIN_TOKEN=… sh
app.get('/install.sh', (c) =>
  c.body(renderInstallScript(env.CONTROLLER_PUBLIC_URL), 200, {
    'content-type': 'text/x-shellscript; charset=utf-8',
    'cache-control': 'no-store',
  }),
);
app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));
app.all('/api/trpc/*', (c) => handleTrpc(c.req.raw));
app.notFound((c) => c.json({ error: 'not found' }, 404));

const server = Bun.serve<AgentWsData>({
  port: env.PORT,
  idleTimeout: 60,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === '/agent/ws') {
      const upgraded = srv.upgrade(req, {
        data: { state: 'await_register', openedAt: Date.now() } satisfies AgentWsData,
      });
      return upgraded ? undefined : new Response('websocket upgrade failed', { status: 400 });
    }
    return app.fetch(req);
  },
  websocket: agentWebSocketHandlers,
});

startWorkers();
// eslint-disable-next-line no-console
console.log(`swarmy controller listening on http://localhost:${server.port}`);
