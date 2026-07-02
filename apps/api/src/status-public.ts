/**
 * Public status-page snapshot (spine stub — owned by slice C5 status-pages).
 *
 * `GET /status/:slug.json` — UNAUTHENTICATED. C5 will serve
 * `statusPages.service#publicStatus(slug)`: component status from
 * health-summary, uptime history from `UptimeSample`, and public incidents —
 * consumed by the SPA's public `/s/$slug` route and by custom status domains.
 *
 * Mounted at `/status` in apps/api/src/index.ts. Inert 501 until C5 lands.
 */
import { Hono } from 'hono';

export const statusPublicApp = new Hono();

statusPublicApp.get('/:slugJson', (c) => {
  const slugJson = c.req.param('slugJson');
  if (!slugJson.endsWith('.json')) return c.json({ error: 'not found' }, 404);
  return c.json({ error: 'not ready' }, 501);
});
