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
import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { publicStatus, systemContext } from '@swarmy/trpc';
import type { PublicStatusView } from '@swarmy/core';
import { hub } from './gateway';
import { createStatusPublicApp } from './status-public-route';

/**
 * Resolve the slug's owning org, then build the snapshot in that org's system
 * context. The incident feed in it is visitor-safe by construction
 * (`publicIncidents`: posted updates + opened/resolved only, never notes).
 */
async function buildSnapshot(slug: string): Promise<PublicStatusView | null> {
  const page = await prisma.statusPage.findUnique({ where: { slug }, select: { orgId: true, enabled: true } });
  if (!page || !page.enabled) return null;
  const ctx = systemContext({ db: prisma, hub, auth: authRegistry.getAuth() }, page.orgId);
  return publicStatus(ctx, slug);
}

const route = createStatusPublicApp(buildSnapshot);

export const statusPublicApp = route.app;

/** Exported for tests / future invalidation on page mutations. */
export const clearStatusCache = route.clearCache;
