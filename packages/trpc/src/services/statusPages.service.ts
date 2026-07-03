import {
  buildInventory,
  STATUS_PAGE_COMPONENT_KINDS,
  UNGROUPED,
  type CreateStatusPageInput,
  type InvService,
  type PublicComponentStatus,
  type PublicComponentView,
  type PublicStatusView,
  type SetStatusPageEnabledInput,
  type StatusComponentOption,
  type StatusPageComponent,
  type StatusPageRefInput,
  type StatusPageView,
  type StatusPagesOverview,
  type UpdateStatusPageInput,
  type UptimeDayView,
} from '@swarmy/core';
import type { OrgContext } from '../context';
import { commandRejected, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { dbLagsFromLabels, summarizeService, DB_LAG_TARGET_SECONDS, type HealthSummary } from './health-summary';
import { publicIncidents } from './incidents.service';
import { DB_CLUSTER_LABEL } from './manageddb.service';
import { CACHE_CLUSTER_LABEL } from './cache.service';

/**
 * Status pages (slice C5) — public component status, uptime history, incident
 * feed. The `StatusPage` row is the user's INPUT artifact (title/slug/domain/
 * component definitions); everything the public page *shows* is derived live:
 * component status from health-summary over the live inventory, uptime bars
 * from `UptimeSample` rows written by {@link sampleUptimeTick}, incidents from
 * the incidents service (`publicIncidents`).
 *
 * The unauthenticated snapshot is served by `apps/api/src/status-public.ts`
 * (`GET /status/<slug>.json`), which MIRRORS {@link publicStatus} because the
 * `@swarmy/trpc` package root does not export it yet.
 * ORCHESTRATOR TODO: export `publicStatus` + `sampleUptimeTick` from
 * `packages/trpc/src/index.ts` so the mirror (and the alert-evaluator's
 * pending `sampleUptimeTick` call) can use the canonical copies:
 *   `export { publicStatus, sampleUptimeTick } from './services/statusPages.service';`
 */

// ── Constants ─────────────────────────────────────────────────────────────────

/** Days of uptime history the public page shows. */
export const UPTIME_WINDOW_DAYS = 90;
/** At most one `UptimeSample` per component per this window. */
export const SAMPLE_THROTTLE_MS = 60_000;
/** Samples older than this are range-deleted opportunistically by the sampler. */
export const UPTIME_RETENTION_DAYS = 92;
/** A stale "latest sample" stops standing in for live status after this long. */
export const LATEST_SAMPLE_MAX_AGE_MS = 10 * 60_000;

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Pure codecs / math (unit-tested in statusPages.service.test.ts) ───────────

const KIND_SET = new Set<string>(STATUS_PAGE_COMPONENT_KINDS);

/**
 * Tolerant `componentsJson` codec: anything that isn't a well-formed component
 * array collapses to `[]` / drops the bad entries — a malformed row must never
 * take the public page (or the sampler) down. Duplicate keys keep the first.
 */
export function parseComponents(value: unknown): StatusPageComponent[] {
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

/** health-summary status → the public status vocabulary. */
export function healthToPublic(status: HealthSummary['status']): PublicComponentStatus {
  if (status === 'healthy') return 'up';
  if (status === 'degraded') return 'degraded';
  if (status === 'down') return 'down';
  return 'unknown';
}

/** Fold many component statuses into the page banner (worst wins). */
export function worstStatus(statuses: PublicComponentStatus[]): PublicComponentStatus {
  const known = statuses.filter((s) => s !== 'unknown');
  if (known.length === 0) return 'unknown';
  if (known.includes('down')) return 'down';
  if (known.includes('degraded')) return 'degraded';
  return 'up';
}

/**
 * Task-state fold for a managed cluster's member services (db/cache
 * components): the same live-inventory signals `composeHealth` reads, minus
 * RED metrics (which don't apply to databases/caches). A replica lag label
 * above target degrades the cluster.
 */
export function statusFromInvServices(
  members: Array<Pick<InvService, 'replicas' | 'scaleToZero' | 'labels'>>,
): PublicComponentStatus {
  const active = members.filter((m) => m.replicas.desired > 0 && !m.scaleToZero);
  if (active.length === 0) return 'unknown';
  if (active.every((m) => m.replicas.running === 0)) return 'down';
  const shortfall = active.some((m) => m.replicas.running < m.replicas.desired);
  const lagging = members.some((m) =>
    dbLagsFromLabels(m.labels).some((l) => l.lagSeconds > DB_LAG_TARGET_SECONDS),
  );
  return shortfall || lagging ? 'degraded' : 'up';
}

/** UTC day key (`YYYY-MM-DD`) for a sample timestamp. */
export function dayKeyUtc(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export interface UptimeBucket {
  total: number;
  /** up=1, degraded=0.5, down=0 — summed over the day's samples. */
  score: number;
}

export interface UptimeSampleLite {
  at: Date;
  status: 'up' | 'degraded' | 'down';
}

/** Bucket raw samples by UTC day (up=1, degraded=0.5, down=0). */
export function samplesToBuckets(samples: UptimeSampleLite[]): Map<string, UptimeBucket> {
  const buckets = new Map<string, UptimeBucket>();
  for (const s of samples) {
    const key = dayKeyUtc(s.at);
    const bucket = buckets.get(key) ?? { total: 0, score: 0 };
    bucket.total += 1;
    bucket.score += s.status === 'up' ? 1 : s.status === 'degraded' ? 0.5 : 0;
    buckets.set(key, bucket);
  }
  return buckets;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Project day-buckets onto a fixed window ending today (UTC): oldest→newest,
 * exactly `days` entries, `pct = score/total*100` (null when the day has no
 * samples). Days outside the window are ignored.
 */
export function bucketsToDays(
  buckets: Map<string, UptimeBucket>,
  days = UPTIME_WINDOW_DAYS,
  now = new Date(),
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

/** Raw samples → daily pct over the window (the canonical aggregation). */
export function aggregateUptimeDays(
  samples: UptimeSampleLite[],
  days = UPTIME_WINDOW_DAYS,
  now = new Date(),
): UptimeDayView[] {
  return bucketsToDays(samplesToBuckets(samples), days, now);
}

/** Whole-window rollup: mean of the days that have data (null = no data). */
export function windowUptimePct(days: UptimeDayView[]): number | null {
  const known = days.filter((d): d is { day: string; pct: number } => d.pct !== null);
  if (known.length === 0) return null;
  return round2(known.reduce((sum, d) => sum + d.pct, 0) / known.length);
}

// ── Row → view mapping ────────────────────────────────────────────────────────

interface PageRow {
  id: string;
  slug: string;
  title: string;
  domain: string | null;
  componentsJson: unknown;
  showUptime: boolean;
  showIncidents: boolean;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function toView(row: PageRow): StatusPageView {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    domain: row.domain,
    components: parseComponents(row.componentsJson),
    showUptime: row.showUptime,
    showIncidents: row.showIncidents,
    enabled: row.enabled,
    publicPath: `/s/${row.slug}`,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function requirePage(ctx: OrgContext, id: string): Promise<PageRow> {
  const row = await ctx.db.statusPage.findFirst({ where: { id, orgId: ctx.activeOrgId } });
  if (!row) throw notFound('status page', id);
  return row;
}

/** Slugs are GLOBAL-unique — they become the public URL `/s/<slug>`. */
async function assertSlugFree(ctx: OrgContext, slug: string, exceptId?: string): Promise<void> {
  const existing = await ctx.db.statusPage.findUnique({ where: { slug }, select: { id: true } });
  if (existing && existing.id !== exceptId) {
    throw commandRejected(`the slug "${slug}" is already taken — pick another`);
  }
}

// ── Queries ───────────────────────────────────────────────────────────────────

/** Aggregates for the Status pages hero. */
export async function overview(ctx: OrgContext): Promise<StatusPagesOverview> {
  const orgId = ctx.activeOrgId;
  const dayAgo = new Date(Date.now() - DAY_MS);
  const [pages, samples24h] = await Promise.all([
    ctx.db.statusPage.findMany({ where: { orgId }, select: { enabled: true, componentsJson: true } }),
    ctx.db.uptimeSample.count({ where: { orgId, at: { gte: dayAgo } } }),
  ]);
  return {
    pages: pages.length,
    enabled: pages.filter((p) => p.enabled).length,
    components: pages.reduce((sum, p) => sum + parseComponents(p.componentsJson).length, 0),
    samples24h,
  };
}

/** The org's status pages, newest first — optionally scoped to one stack. */
export async function listPages(ctx: OrgContext, stack?: string): Promise<StatusPageView[]> {
  const rows = await ctx.db.statusPage.findMany({
    where: { orgId: ctx.activeOrgId, ...(stack ? { stackName: stack } : {}) },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toView);
}

/**
 * Everything a page component can watch, read LIVE from Docker truth: plain
 * services from the inventory (managed cluster members are folded into their
 * cluster option), db/cache clusters from their `swarmy.db.cluster` /
 * `swarmy.cache.cluster` labels, regions from node `swarmy.region` labels,
 * plus the native ingress edge when it is deployed.
 *
 * With a `stack`, only that stack's services and the db/cache clusters whose
 * member services live in it are offered — estate-wide options (regions, the
 * ingress edge) are left out so a stack's page watches its own components.
 */
export async function componentOptions(
  ctx: OrgContext,
  stack?: string,
): Promise<StatusComponentOption[]> {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const inv = buildInventory(services, containers).services;

  const out: StatusComponentOption[] = [];
  const dbClusters = new Map<string, number>();
  const cacheClusters = new Map<string, number>();

  for (const svc of inv) {
    if (stack && svc.stack !== stack) continue;
    const db = svc.labels[DB_CLUSTER_LABEL];
    const cache = svc.labels[CACHE_CLUSTER_LABEL];
    if (db) dbClusters.set(db, (dbClusters.get(db) ?? 0) + 1);
    else if (cache) cacheClusters.set(cache, (cacheClusters.get(cache) ?? 0) + 1);
    else if (svc.name === 'swarmy-ingress-caddy') {
      if (!stack) out.push({ kind: 'ingress', ref: svc.name, label: 'Ingress edge', hint: 'reverse proxy' });
    } else {
      out.push({
        kind: 'service',
        ref: svc.name,
        label: svc.name,
        hint: svc.stack === UNGROUPED ? null : `stack ${svc.stack}`,
      });
    }
  }
  for (const [cluster, members] of dbClusters) {
    out.push({ kind: 'db', ref: cluster, label: cluster, hint: `database · ${members} member${members === 1 ? '' : 's'}` });
  }
  for (const [cluster, members] of cacheClusters) {
    out.push({ kind: 'cache', ref: cluster, label: cluster, hint: `cache · ${members} member${members === 1 ? '' : 's'}` });
  }
  if (!stack) {
    for (const [region, nodeIds] of ctx.hub.nodesByRegion(ctx.activeOrgId)) {
      out.push({ kind: 'region', ref: region, label: region, hint: `${nodeIds.length} node${nodeIds.length === 1 ? '' : 's'}` });
    }
  }
  return out.sort((a, b) => (a.kind === b.kind ? a.ref.localeCompare(b.ref) : a.kind.localeCompare(b.kind)));
}

// ── Live component status ─────────────────────────────────────────────────────

function invServices(ctx: OrgContext): InvService[] {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  return buildInventory(services, containers).services;
}

function regionStatus(ctx: OrgContext, region: string): PublicComponentStatus {
  const nodeIds = ctx.hub.nodesByRegion(ctx.activeOrgId).get(region) ?? [];
  if (nodeIds.length === 0) return 'unknown';
  const online = nodeIds.filter((id) => ctx.hub.isOnline(id)).length;
  if (online === 0) return 'down';
  return online < nodeIds.length ? 'degraded' : 'up';
}

/**
 * Resolve one component's CURRENT status from live truth:
 *  - service / ingress → health-summary `summarizeService` (tasks, RED, lag);
 *  - db / cache → task-state fold over the cluster's labelled member services;
 *  - region → its nodes' hub connectivity.
 */
export async function resolveComponentStatus(
  ctx: OrgContext,
  component: Pick<StatusPageComponent, 'kind' | 'ref'>,
): Promise<PublicComponentStatus> {
  switch (component.kind) {
    case 'service':
    case 'ingress': {
      const summary = await summarizeService(ctx, component.ref);
      return healthToPublic(summary.status);
    }
    case 'db':
    case 'cache': {
      const label = component.kind === 'db' ? DB_CLUSTER_LABEL : CACHE_CLUSTER_LABEL;
      const members = invServices(ctx).filter((s) => s.labels[label] === component.ref);
      return statusFromInvServices(members);
    }
    case 'region':
      return regionStatus(ctx, component.ref);
    default:
      return 'unknown';
  }
}

// ── Public snapshot ───────────────────────────────────────────────────────────

interface DailyAggRow {
  componentKey: string;
  day: Date;
  total: number;
  up: number;
  degraded: number;
}

/**
 * SQL-side daily aggregation — a component can hold ~130k samples over 90 days
 * (one per minute), far too many rows to fold in JS per request.
 */
async function fetchDailyAgg(ctx: OrgContext, pageId: string, since: Date): Promise<DailyAggRow[]> {
  return await ctx.db.$queryRaw<DailyAggRow[]>`
    SELECT "componentKey",
           date_trunc('day', "at" AT TIME ZONE 'UTC') AS day,
           count(*)::int AS total,
           (count(*) FILTER (WHERE "status" = 'UP'))::int AS up,
           (count(*) FILTER (WHERE "status" = 'DEGRADED'))::int AS degraded
    FROM "uptime_sample"
    WHERE "pageId" = ${pageId} AND "at" >= ${since}
    GROUP BY 1, 2`;
}

/** Aggregated SQL rows → per-component day buckets (shared shape with the pure path). */
export function aggRowsToBuckets(
  rows: Array<{ componentKey: string; day: Date | string; total: number; up: number; degraded: number }>,
): Map<string, Map<string, UptimeBucket>> {
  const byComponent = new Map<string, Map<string, UptimeBucket>>();
  for (const row of rows) {
    const day = typeof row.day === 'string' ? row.day.slice(0, 10) : dayKeyUtc(row.day);
    const buckets = byComponent.get(row.componentKey) ?? new Map<string, UptimeBucket>();
    buckets.set(day, { total: row.total, score: row.up + row.degraded * 0.5 });
    byComponent.set(row.componentKey, buckets);
  }
  return byComponent;
}

const DB_STATUS_TO_PUBLIC: Record<string, 'up' | 'degraded' | 'down'> = {
  UP: 'up',
  DEGRADED: 'degraded',
  DOWN: 'down',
};

/**
 * The full public snapshot for `/status/<slug>.json` and the tRPC preview:
 * page meta, per-component current status (live, falling back to the latest
 * recent sample), 90-day uptime bars, and the public incident feed. Throws
 * NOT_FOUND for unknown or disabled slugs. Pure read — no audit row.
 *
 * KEEP IN SYNC with the mirror in `apps/api/src/status-public.ts` until the
 * package root exports this (see the header ORCHESTRATOR TODO).
 */
export async function publicStatus(ctx: OrgContext, slug: string): Promise<PublicStatusView> {
  const page = await ctx.db.statusPage.findFirst({ where: { slug, orgId: ctx.activeOrgId } });
  if (!page || !page.enabled) throw notFound('status page', slug);

  const components = parseComponents(page.componentsJson);
  const now = new Date();
  const since = new Date(now.getTime() - UPTIME_WINDOW_DAYS * DAY_MS);

  const [aggRows, incidents, latestRows] = await Promise.all([
    page.showUptime && components.length > 0
      ? fetchDailyAgg(ctx, page.id, since)
      : Promise.resolve([] as DailyAggRow[]),
    page.showIncidents ? publicIncidents(ctx, page.id) : Promise.resolve([]),
    ctx.db.uptimeSample.findMany({
      where: { pageId: page.id },
      orderBy: { at: 'desc' },
      distinct: ['componentKey'],
      select: { componentKey: true, at: true, status: true },
    }),
  ]);

  const bucketsByComponent = aggRowsToBuckets(aggRows);
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

// ── Uptime sampler (called each tick by the alert-evaluator, slice C3) ────────

/** pageId|componentKey → last sampled ms (module map; restart = one extra sample). */
const lastSampleAt = new Map<string, number>();
/** orgId → last retention prune ms. */
const lastPruneAt = new Map<string, number>();
const PRUNE_EVERY_MS = 60 * 60_000;

/**
 * Sample one uptime datapoint per enabled status-page component (throttled to
 * one per component per {@link SAMPLE_THROTTLE_MS}). `unknown` statuses are
 * skipped — no data beats wrong data. Also opportunistically range-deletes
 * samples past {@link UPTIME_RETENTION_DAYS} (hourly per org). System write —
 * intentionally not audited (it would flood the log every minute).
 */
export async function sampleUptimeTick(ctx: OrgContext): Promise<void> {
  const orgId = ctx.activeOrgId;
  const pages = await ctx.db.statusPage.findMany({ where: { orgId, enabled: true } });
  const now = Date.now();

  if (pages.length > 0) {
    // Resolve each distinct kind|ref once per tick, shared across pages.
    const statusCache = new Map<string, PublicComponentStatus>();
    const rows: Array<{
      orgId: string;
      pageId: string;
      componentKey: string;
      at: Date;
      status: 'UP' | 'DEGRADED' | 'DOWN';
    }> = [];

    for (const page of pages) {
      for (const component of parseComponents(page.componentsJson)) {
        const throttleKey = `${page.id}|${component.key}`;
        const last = lastSampleAt.get(throttleKey);
        if (last !== undefined && now - last < SAMPLE_THROTTLE_MS) continue;

        const cacheKey = `${component.kind}|${component.ref}`;
        let status = statusCache.get(cacheKey);
        if (status === undefined) {
          status = await resolveComponentStatus(ctx, component).catch(
            (): PublicComponentStatus => 'unknown',
          );
          statusCache.set(cacheKey, status);
        }
        if (status === 'unknown') continue;

        lastSampleAt.set(throttleKey, now);
        rows.push({
          orgId,
          pageId: page.id,
          componentKey: component.key,
          at: new Date(now),
          status: status === 'up' ? 'UP' : status === 'degraded' ? 'DEGRADED' : 'DOWN',
        });
      }
    }
    if (rows.length > 0) await ctx.db.uptimeSample.createMany({ data: rows });
  }

  const lastPrune = lastPruneAt.get(orgId) ?? 0;
  if (now - lastPrune >= PRUNE_EVERY_MS) {
    lastPruneAt.set(orgId, now);
    const cutoff = new Date(now - UPTIME_RETENTION_DAYS * DAY_MS);
    await ctx.db.uptimeSample
      .deleteMany({ where: { orgId, at: { lt: cutoff } } })
      .catch(() => undefined);
  }
}

// ── Mutations ─────────────────────────────────────────────────────────────────

/**
 * Create a status page. The slug is global-unique (it becomes `/s/<slug>`).
 *
 * Custom domain: stored on the row; serving it requires an ingress vhost
 * `host → controller public URL`. The per-service route API
 * (`ingress-routes-api.ts#setServiceRoutes`) only writes `swarmy.ingress.routes`
 * labels that dial a SWARM SERVICE's port — there is no clean helper for an
 * arbitrary controller upstream. ORCHESTRATOR TODO: add a controller-upstream
 * route concept to ingress rendering (e.g. an org-level static vhost list in
 * `ingress.service.ts#renderInput` pointing at `CONTROLLER_PUBLIC_URL`), then
 * wire it here on create/update/delete. Until then the UI shows the DNS/proxy
 * hint next to the domain field.
 */
export async function createPage(
  ctx: OrgContext,
  input: CreateStatusPageInput & { stackName?: string },
): Promise<StatusPageView> {
  await assertSlugFree(ctx, input.slug);
  const row = await ctx.db.statusPage.create({
    data: {
      orgId: ctx.activeOrgId,
      slug: input.slug,
      title: input.title,
      domain: input.domain?.toLowerCase() ?? null,
      stackName: input.stackName ?? null,
      componentsJson: input.components as unknown as object,
      showUptime: input.showUptime,
      showIncidents: input.showIncidents,
      enabled: input.enabled,
    },
  });
  await writeAudit(ctx, {
    action: 'statusPages.create',
    targetType: 'statusPage',
    targetId: row.id,
    metadata: {
      slug: row.slug,
      title: row.title,
      components: input.components.length,
      ...(input.stackName ? { stackName: input.stackName } : {}),
    },
  });
  return toView(row);
}

/** Update a page's meta, components, domain, stack link, visibility toggles. */
export async function updatePage(
  ctx: OrgContext,
  input: UpdateStatusPageInput & { stackName?: string | null },
): Promise<StatusPageView> {
  const existing = await requirePage(ctx, input.id);
  if (input.slug !== undefined && input.slug !== existing.slug) {
    await assertSlugFree(ctx, input.slug, existing.id);
  }
  const row = await ctx.db.statusPage.update({
    where: { id: existing.id },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.slug !== undefined ? { slug: input.slug } : {}),
      ...(input.domain !== undefined ? { domain: input.domain?.toLowerCase() ?? null } : {}),
      ...(input.stackName !== undefined ? { stackName: input.stackName } : {}),
      ...(input.components !== undefined
        ? { componentsJson: input.components as unknown as object }
        : {}),
      ...(input.showUptime !== undefined ? { showUptime: input.showUptime } : {}),
      ...(input.showIncidents !== undefined ? { showIncidents: input.showIncidents } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    },
  });
  await writeAudit(ctx, {
    action: 'statusPages.update',
    targetType: 'statusPage',
    targetId: row.id,
    metadata: { slug: row.slug, fields: Object.keys(input).filter((k) => k !== 'id') },
  });
  return toView(row);
}

/** Delete a page (its samples cascade with it). */
export async function removePage(
  ctx: OrgContext,
  input: StatusPageRefInput,
): Promise<{ id: string; removed: true }> {
  const existing = await requirePage(ctx, input.id);
  await ctx.db.statusPage.delete({ where: { id: existing.id } });
  await writeAudit(ctx, {
    action: 'statusPages.delete',
    targetType: 'statusPage',
    targetId: existing.id,
    metadata: { slug: existing.slug, title: existing.title },
  });
  return { id: existing.id, removed: true };
}

/** Flip a page live / dark (a dark page 404s publicly, history is kept). */
export async function setEnabled(
  ctx: OrgContext,
  input: SetStatusPageEnabledInput,
): Promise<StatusPageView> {
  const existing = await requirePage(ctx, input.id);
  const row = await ctx.db.statusPage.update({
    where: { id: existing.id },
    data: { enabled: input.enabled },
  });
  await writeAudit(ctx, {
    action: 'statusPages.setEnabled',
    targetType: 'statusPage',
    targetId: row.id,
    metadata: { slug: row.slug, enabled: input.enabled },
  });
  return toView(row);
}
