/**
 * Public status-page snapshot (slice C5 status-pages).
 *
 * `GET /status/:slug.json` — UNAUTHENTICATED. Serves the same snapshot as
 * `statusPages.service#publicStatus(slug)`: per-component current status
 * (health-summary over live truth, falling back to the freshest UptimeSample),
 * 90-day uptime bars aggregated from `UptimeSample`, and the public incident
 * feed. Consumed by the SPA's public `/s/$slug` route and by custom status
 * domains. Unknown / disabled slugs 404; responses are cached in-memory 30s.
 *
 * The snapshot assembly here is a documented MIRROR of the unit-tested
 * canonical copy in `@swarmy/trpc` `statusPages.service.ts` (this app can only
 * import the trpc package root, which does not export `publicStatus`). Keep in
 * sync. ORCHESTRATOR TODO: once `packages/trpc/src/index.ts` exports
 * `publicStatus` (`export { publicStatus, sampleUptimeTick } from
 * './services/statusPages.service';`), replace `buildSnapshot` below with the
 * canonical call and delete the mirror block.
 *
 * Mounted at `/status` in apps/api/src/index.ts.
 */
import { Hono } from 'hono';
import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { summarizeService, systemContext, type OrgContext } from '@swarmy/trpc';
import {
  buildInventory,
  STATUS_PAGE_COMPONENT_KINDS,
  type InvService,
  type PublicComponentStatus,
  type PublicComponentView,
  type PublicIncidentView,
  type PublicStatusView,
  type StatusPageComponent,
  type UptimeDayView,
} from '@swarmy/core';
import { hub } from './gateway';

// ── Tunables (mirror of statusPages.service.ts) ──────────────────────────────

const UPTIME_WINDOW_DAYS = 90;
const LATEST_SAMPLE_MAX_AGE_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How long a rendered snapshot (and a 404) is served from memory. */
const CACHE_TTL_MS = 30_000;

// Label mirrors (canonical: manageddb.service / cache.service / health-summary).
const DB_CLUSTER_LABEL = 'swarmy.db.cluster';
const CACHE_CLUSTER_LABEL = 'swarmy.cache.cluster';
const DB_LAG_LABEL_PREFIX = 'swarmy.db.lag.';
const DB_LAG_TARGET_SECONDS = 10;

// ── Pure mirrors of statusPages.service.ts (keep in sync) ────────────────────

const KIND_SET = new Set<string>(STATUS_PAGE_COMPONENT_KINDS);

function parseComponents(value: unknown): StatusPageComponent[] {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const out: StatusPageComponent[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.key !== 'string' || e.key.length === 0 || seen.has(e.key)) continue;
    if (typeof e.ref !== 'string' || e.ref.length === 0) continue;
    if (typeof e.kind !== 'string' || !KIND_SET.has(e.kind)) continue;
    const label = typeof e.label === 'string' && e.label.length > 0 ? e.label : e.key;
    seen.add(e.key);
    out.push({ key: e.key, label, kind: e.kind as StatusPageComponent['kind'], ref: e.ref });
  }
  return out;
}

function worstStatus(statuses: PublicComponentStatus[]): PublicComponentStatus {
  const known = statuses.filter((s) => s !== 'unknown');
  if (known.length === 0) return 'unknown';
  if (known.includes('down')) return 'down';
  if (known.includes('degraded')) return 'degraded';
  return 'up';
}

/** Lag label value → seconds (mirror of health-summary `parseLagSeconds`). */
function lagSeconds(raw: string): number | null {
  const v = raw.trim().toLowerCase();
  const ms = /^(\d+(?:\.\d+)?)ms$/.exec(v);
  if (ms) return Number(ms[1]) / 1000;
  const sec = /^(\d+(?:\.\d+)?)s$/.exec(v);
  if (sec) return Number(sec[1]);
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return n < 600 ? n : n / 1000;
}

function statusFromInvServices(members: InvService[]): PublicComponentStatus {
  const active = members.filter((m) => m.replicas.desired > 0 && !m.scaleToZero);
  if (active.length === 0) return 'unknown';
  if (active.every((m) => m.replicas.running === 0)) return 'down';
  const shortfall = active.some((m) => m.replicas.running < m.replicas.desired);
  const lagging = members.some((m) =>
    Object.entries(m.labels).some(([key, value]) => {
      if (!key.startsWith(DB_LAG_LABEL_PREFIX)) return false;
      const lag = lagSeconds(value);
      return lag !== null && lag > DB_LAG_TARGET_SECONDS;
    }),
  );
  return shortfall || lagging ? 'degraded' : 'up';
}

const dayKeyUtc = (at: Date): string => at.toISOString().slice(0, 10);
const round2 = (n: number): number => Math.round(n * 100) / 100;

interface UptimeBucket {
  total: number;
  score: number;
}

function bucketsToDays(
  buckets: Map<string, UptimeBucket>,
  days: number,
  now: Date,
): UptimeDayView[] {
  const out: UptimeDayView[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = dayKeyUtc(new Date(now.getTime() - i * DAY_MS));
    const bucket = buckets.get(day);
    out.push({
      day,
      pct: bucket && bucket.total > 0 ? round2((bucket.score / bucket.total) * 100) : null,
    });
  }
  return out;
}

function windowUptimePct(days: UptimeDayView[]): number | null {
  const known = days.filter((d): d is { day: string; pct: number } => d.pct !== null);
  if (known.length === 0) return null;
  return round2(known.reduce((sum, d) => sum + d.pct, 0) / known.length);
}

// ── Live reads (systemContext against the org that owns the slug) ────────────

function orgContext(orgId: string): OrgContext {
  return systemContext({ db: prisma, hub, auth: authRegistry.getAuth() }, orgId);
}

async function resolveComponentStatus(
  ctx: OrgContext,
  component: StatusPageComponent,
): Promise<PublicComponentStatus> {
  switch (component.kind) {
    case 'service':
    case 'ingress': {
      const summary = await summarizeService(ctx, component.ref);
      if (summary.status === 'healthy') return 'up';
      if (summary.status === 'degraded') return 'degraded';
      if (summary.status === 'down') return 'down';
      return 'unknown';
    }
    case 'db':
    case 'cache': {
      const label = component.kind === 'db' ? DB_CLUSTER_LABEL : CACHE_CLUSTER_LABEL;
      const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
      const members = buildInventory(services, containers).services.filter(
        (s) => s.labels[label] === component.ref,
      );
      return statusFromInvServices(members);
    }
    case 'region': {
      const nodeIds = ctx.hub.nodesByRegion(ctx.activeOrgId).get(component.ref) ?? [];
      if (nodeIds.length === 0) return 'unknown';
      const online = nodeIds.filter((id) => ctx.hub.isOnline(id)).length;
      if (online === 0) return 'down';
      return online < nodeIds.length ? 'degraded' : 'up';
    }
    default:
      return 'unknown';
  }
}

/** Mirror of incidents.service `publicIncidents`: open + last 30d resolved. */
async function publicIncidents(orgId: string): Promise<PublicIncidentView[]> {
  const monthAgo = new Date(Date.now() - 30 * DAY_MS);
  const rows = await prisma.incident.findMany({
    where: {
      orgId,
      OR: [{ status: 'OPEN' }, { status: 'RESOLVED', resolvedAt: { gte: monthAgo } }],
    },
    orderBy: [{ status: 'asc' }, { openedAt: 'desc' }],
    take: 25,
    include: { events: { orderBy: { at: 'desc' }, take: 10 } },
  });
  const severities = new Set(['minor', 'major', 'critical']);
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status === 'OPEN' ? ('open' as const) : ('resolved' as const),
    severity: (severities.has(row.severity) ? row.severity : 'major') as PublicIncidentView['severity'],
    openedAt: row.openedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    updates: row.events.map((e) => ({
      at: e.at.toISOString(),
      kind: e.kind,
      message: e.message,
    })),
  }));
}

const DB_STATUS_TO_PUBLIC: Record<string, 'up' | 'degraded' | 'down'> = {
  UP: 'up',
  DEGRADED: 'degraded',
  DOWN: 'down',
};

/** MIRROR of statusPages.service `publicStatus` — see the header note. */
async function buildSnapshot(slug: string): Promise<PublicStatusView | null> {
  const page = await prisma.statusPage.findUnique({ where: { slug } });
  if (!page || !page.enabled) return null;

  const ctx = orgContext(page.orgId);
  const components = parseComponents(page.componentsJson);
  const now = new Date();
  const since = new Date(now.getTime() - UPTIME_WINDOW_DAYS * DAY_MS);

  const [aggRows, incidents, latestRows] = await Promise.all([
    page.showUptime && components.length > 0
      ? prisma.$queryRaw<
          Array<{ componentKey: string; day: Date; total: number; up: number; degraded: number }>
        >`
          SELECT "componentKey",
                 date_trunc('day', "at" AT TIME ZONE 'UTC') AS day,
                 count(*)::int AS total,
                 (count(*) FILTER (WHERE "status" = 'UP'))::int AS up,
                 (count(*) FILTER (WHERE "status" = 'DEGRADED'))::int AS degraded
          FROM "uptime_sample"
          WHERE "pageId" = ${page.id} AND "at" >= ${since}
          GROUP BY 1, 2`
      : Promise.resolve([]),
    page.showIncidents ? publicIncidents(page.orgId) : Promise.resolve([]),
    prisma.uptimeSample.findMany({
      where: { pageId: page.id },
      orderBy: { at: 'desc' },
      distinct: ['componentKey'],
      select: { componentKey: true, at: true, status: true },
    }),
  ]);

  const bucketsByComponent = new Map<string, Map<string, UptimeBucket>>();
  for (const row of aggRows) {
    const day =
      typeof row.day === 'string' ? (row.day as string).slice(0, 10) : dayKeyUtc(row.day);
    const buckets = bucketsByComponent.get(row.componentKey) ?? new Map<string, UptimeBucket>();
    buckets.set(day, { total: row.total, score: row.up + row.degraded * 0.5 });
    bucketsByComponent.set(row.componentKey, buckets);
  }
  const latestByKey = new Map(latestRows.map((r) => [r.componentKey, r]));

  const componentViews: PublicComponentView[] = [];
  for (const component of components) {
    let status = await resolveComponentStatus(ctx, component).catch(
      (): PublicComponentStatus => 'unknown',
    );
    if (status === 'unknown') {
      const latest = latestByKey.get(component.key);
      if (latest && now.getTime() - latest.at.getTime() <= LATEST_SAMPLE_MAX_AGE_MS) {
        status = DB_STATUS_TO_PUBLIC[latest.status] ?? 'unknown';
      }
    }
    const uptime90d = page.showUptime
      ? bucketsToDays(bucketsByComponent.get(component.key) ?? new Map(), UPTIME_WINDOW_DAYS, now)
      : [];
    componentViews.push({
      key: component.key,
      label: component.label,
      kind: component.kind,
      status,
      uptime90d,
      uptimePct: windowUptimePct(uptime90d),
    });
  }

  return {
    page: { slug: page.slug, title: page.title },
    overall: worstStatus(componentViews.map((c) => c.status)),
    components: componentViews,
    incidents,
    maintenance: [],
    generatedAt: now.toISOString(),
  };
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
