/**
 * The `/status/:slug.json` route itself — slug check, 30s in-memory cache,
 * headers — over an injected snapshot builder, so it is testable against a
 * real store without the controller's gateway/prisma singletons.
 * `status-public.ts` wires it to the live controller.
 */
import { Hono } from 'hono';
import type { PublicStatusView } from '@swarmy/core';

/** How long a rendered snapshot (and a 404) is served from memory. */
const CACHE_TTL_MS = 30_000;

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface CacheEntry {
  expires: number;
  snapshot: PublicStatusView | null;
}

export function createStatusPublicApp(buildSnapshot: (slug: string) => Promise<PublicStatusView | null>): {
  app: Hono;
  clearCache: () => void;
} {
  const cache = new Map<string, CacheEntry>();
  const app = new Hono();

  app.get('/:slugJson', async (c) => {
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

  return { app, clearCache: () => cache.clear() };
}
