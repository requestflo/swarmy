/**
 * Public status-page snapshot (slice C5 status-pages).
 *
 * `GET /status/:slug.json` — UNAUTHENTICATED. Serves
 * `statusPages.service#publicStatus(slug)`: per-component current status
 * (health-summary over live truth, falling back to the freshest UptimeSample),
 * 90-day uptime bars aggregated from `UptimeSample`, and the public incident
 * feed. Consumed by the SPA's public `/s/$slug` route and by custom status
 * domains. Unknown / disabled slugs 404; responses are cached in-memory 30s.
 *
 * Mounted at `/status` in apps/api/src/index.ts.
 */
import { Hono } from 'hono';
import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { publicStatus, systemContext } from '@swarmy/trpc';
import type { PublicStatusView } from '@swarmy/core';
import { hub } from './gateway';

/** How long a rendered snapshot (and a 404) is served from memory. */
const CACHE_TTL_MS = 30_000;

/** Resolve the slug's owning org, then build the snapshot in that org's system context. */
async function buildSnapshot(slug: string): Promise<PublicStatusView | null> {
  const page = await prisma.statusPage.findUnique({ where: { slug }, select: { orgId: true, enabled: true } });
  if (!page || !page.enabled) return null;
  const ctx = systemContext({ db: prisma, hub, auth: authRegistry.getAuth() }, page.orgId);
  return publicStatus(ctx, slug);
}

// ── Route + 30s in-memory cache ───────────────────────────────────────────────

interface CacheEntry {
  expires: number;
  snapshot: PublicStatusView | null;
}

const cache = new Map<string, CacheEntry>();

/** Exported for tests / future invalidation on page mutations. */
export function clearStatusCache(): void {
  cache.clear();
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const statusPublicApp = new Hono();

statusPublicApp.get('/:slugJson', async (c) => {
  const slugJson = c.req.param('slugJson');
  if (!slugJson.endsWith('.json')) return c.json({ error: 'not found' }, 404);
  const slug = slugJson.slice(0, -'.json'.length);
  if (!SLUG_RE.test(slug)) return c.json({ error: 'not found' }, 404);

  const now = Date.now();
  let entry = cache.get(slug);
  if (!entry || entry.expires <= now) {
    // Occasional sweep so dead slugs don't accumulate entries forever.
    if (cache.size > 500) {
      for (const [key, e] of cache) if (e.expires <= now) cache.delete(key);
    }
    const snapshot = await buildSnapshot(slug).catch(() => null);
    entry = { expires: now + CACHE_TTL_MS, snapshot };
    cache.set(slug, entry);
  }

  if (!entry.snapshot) return c.json({ error: 'not found' }, 404);
  return c.json(entry.snapshot, 200, {
    'cache-control': 'public, max-age=30',
    'access-control-allow-origin': '*',
  });
});
