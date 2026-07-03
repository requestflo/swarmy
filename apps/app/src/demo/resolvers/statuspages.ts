import type {
  CreateStatusPageInput,
  PublicIncidentView,
  PublicComponentStatus,
  PublicStatusView,
  SetStatusPageEnabledInput,
  StatusComponentOption,
  StatusPageComponent,
  StatusPageRefInput,
  StatusPageView,
  StatusPagesOverview,
  UpdateStatusPageInput,
  UptimeDayView,
} from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * Status-pages demo resolvers — the Status pages settings surface
 * (`/status-pages`) plus the public snapshot the `/s/$slug` route renders in
 * demo mode (via `statusPages.preview`, since there is no controller to serve
 * `GET /status/<slug>.json`).
 *
 * Seeded world: one live page `requestflo-status` ("RequestFlo") watching five
 * components with 90 days of believable uptime (one rough day two weeks ago
 * matching a resolved incident) and the checkout service currently degraded —
 * so the public page shows an amber banner, imperfect bars and an incident
 * history without any interaction. Return shapes come straight from
 * `@swarmy/core` views, so the dashboard renders without surprises.
 */

// ───────────────────────────────────────────── demo world ──

/** Demo rows carry the stack link the real `StatusPage.stackName` column holds. */
type StackedPage = StatusPageView & { stackName: string | null };

interface StatusPagesState {
  pages: StackedPage[];
  /** `${pageId}|${componentKey}` → 90 daily entries (oldest→newest). */
  uptime: Record<string, UptimeDayView[]>;
  /** `${pageId}|${componentKey}` → current status override. */
  statuses: Record<string, PublicComponentStatus>;
  incidents: PublicIncidentView[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 90;
/** The seeded incident happened this many days ago. */
const INCIDENT_DAYS_AGO = 13;

const nowIso = (): string => new Date().toISOString();
const rid = (prefix: string): string => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
const round2 = (n: number): number => Math.round(n * 100) / 100;

function getState(store: DemoStore): StatusPagesState {
  return store.extra.statuspages as StatusPagesState;
}

/** Deterministic PRNG so the demo bars are stable across reloads. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dayKeyUtc = (msAgoDays: number): string =>
  new Date(Date.now() - msAgoDays * DAY_MS).toISOString().slice(0, 10);

/** 90 days of mostly-perfect uptime with a few wobbles (and one rough day). */
function genUptime(seed: number, roughDayAgo: number | null, roughPct: number): UptimeDayView[] {
  const rand = mulberry32(seed);
  const out: UptimeDayView[] = [];
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    let pct: number | null = 100;
    const r = rand();
    if (roughDayAgo !== null && i === roughDayAgo) pct = roughPct;
    else if (r > 0.96) pct = round2(99 + rand()); // the odd blip
    else if (r < 0.015) pct = null; // a day with no samples (sampler was off)
    out.push({ day: dayKeyUtc(i), pct });
  }
  return out;
}

function windowPct(days: UptimeDayView[]): number | null {
  const known = days.filter((d): d is { day: string; pct: number } => d.pct !== null);
  if (known.length === 0) return null;
  return round2(known.reduce((s, d) => s + d.pct, 0) / known.length);
}

function worst(statuses: PublicComponentStatus[]): PublicComponentStatus {
  const known = statuses.filter((s) => s !== 'unknown');
  if (known.length === 0) return 'unknown';
  if (known.includes('down')) return 'down';
  if (known.includes('degraded')) return 'degraded';
  return 'up';
}

/** Live status for a component from the shared demo world (services/nodes). */
function liveStatus(store: DemoStore, component: StatusPageComponent): PublicComponentStatus {
  if (component.kind === 'service' || component.kind === 'ingress') {
    const svc = store.services.find((s) => s.name === component.ref);
    if (!svc) return 'unknown';
    if (svc.status === 'running') return 'up';
    if (svc.status === 'degraded' || svc.status === 'deploying') return 'degraded';
    return 'down';
  }
  if (component.kind === 'region') {
    const members = store.nodes.filter(
      (n) => (n as { labels?: Record<string, string> }).labels?.['swarmy.region'] === component.ref,
    );
    if (members.length === 0) return 'unknown';
    const online = members.filter((n) => n.status === 'online').length;
    if (online === 0) return 'down';
    return online < members.length ? 'degraded' : 'up';
  }
  return 'up'; // demo managed clusters are healthy unless overridden
}

function toSnapshot(store: DemoStore, page: StatusPageView): PublicStatusView {
  const st = getState(store);
  const components = page.components.map((component) => {
    const key = `${page.id}|${component.key}`;
    const status = st.statuses[key] ?? liveStatus(store, component);
    const uptime90d = page.showUptime ? (st.uptime[key] ?? emptyDays()) : [];
    return {
      key: component.key,
      label: component.label,
      kind: component.kind,
      status,
      uptime90d,
      uptimePct: windowPct(uptime90d),
    };
  });
  return {
    page: { slug: page.slug, title: page.title },
    overall: worst(components.map((c) => c.status)),
    components,
    incidents: page.showIncidents ? st.incidents : [],
    maintenance: [],
    generatedAt: nowIso(),
  };
}

function emptyDays(): UptimeDayView[] {
  const out: UptimeDayView[] = [];
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) out.push({ day: dayKeyUtc(i), pct: null });
  return out;
}

// ───────────────────────────────────────────── resolvers ──

export const statuspages: DomainResolvers = {
  handlers: {
    'statusPages.overview': (_i, s): StatusPagesOverview => {
      const st = getState(s);
      const enabled = st.pages.filter((p) => p.enabled);
      return {
        pages: st.pages.length,
        enabled: enabled.length,
        components: st.pages.reduce((sum, p) => sum + p.components.length, 0),
        samples24h: enabled.reduce((sum, p) => sum + p.components.length, 0) * 1440,
      };
    },

    'statusPages.list': (i, s): StatusPageView[] => {
      const { stack } = (i as { stack?: string } | undefined) ?? {};
      const pages = getState(s).pages;
      return stack ? pages.filter((p) => p.stackName === stack) : [...pages];
    },

    'statusPages.componentOptions': (i, s): StatusComponentOption[] => {
      const { stack } = (i as { stack?: string } | undefined) ?? {};
      const stackNameOf = (stackId: string | null): string | null =>
        stackId ? (s.stacks.find((st) => st.id === stackId)?.name ?? stackId) : null;
      const options: StatusComponentOption[] = s.services
        .filter((svc) => !['postgres', 'redis'].includes(svc.name))
        .filter((svc) => !stack || stackNameOf(svc.stackId) === stack)
        .map((svc) => ({
          kind: 'service' as const,
          ref: svc.name,
          label: svc.name,
          hint: svc.stackId ? `stack ${stackNameOf(svc.stackId)}` : null,
        }));
      // The managed clusters live in the `data` stack (postgres/redis members).
      if (!stack || stack === 'data') {
        options.push(
          { kind: 'db', ref: 'main-db', label: 'main-db', hint: 'database · 3 members' },
          { kind: 'cache', ref: 'sessions', label: 'sessions', hint: 'cache · 2 members' },
        );
      }
      if (!stack) {
        const regions = new Set<string>();
        for (const n of s.nodes) {
          const region = (n as { labels?: Record<string, string> }).labels?.['swarmy.region'];
          if (region) regions.add(region);
        }
        for (const region of [...regions].sort()) {
          const count = s.nodes.filter(
            (n) => (n as { labels?: Record<string, string> }).labels?.['swarmy.region'] === region,
          ).length;
          options.push({ kind: 'region', ref: region, label: region, hint: `${count} node${count === 1 ? '' : 's'}` });
        }
        options.push({ kind: 'ingress', ref: 'swarmy-ingress-caddy', label: 'Ingress edge', hint: 'reverse proxy' });
      }
      return options;
    },

    'statusPages.preview': (i, s): PublicStatusView => {
      const { slug } = i as { slug: string };
      const page = getState(s).pages.find((p) => p.slug === slug && p.enabled);
      if (!page) throw new Error(`status page "${slug}" not found`);
      return toSnapshot(s, page);
    },

    'statusPages.create': (i, s): StatusPageView => {
      const input = i as CreateStatusPageInput & { stackName?: string };
      const st = getState(s);
      if (st.pages.some((p) => p.slug === input.slug)) {
        throw new Error(`the slug "${input.slug}" is already taken — pick another`);
      }
      const page: StackedPage = {
        id: rid('sp'),
        slug: input.slug,
        title: input.title,
        domain: input.domain?.toLowerCase() ?? null,
        stackName: input.stackName ?? null,
        components: input.components ?? [],
        showUptime: input.showUptime ?? true,
        showIncidents: input.showIncidents ?? true,
        enabled: input.enabled ?? true,
        publicPath: `/s/${input.slug}`,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      st.pages = [page, ...st.pages];
      return page;
    },

    'statusPages.update': (i, s): StatusPageView => {
      const input = i as UpdateStatusPageInput & { stackName?: string | null };
      const st = getState(s);
      const page = st.pages.find((p) => p.id === input.id);
      if (!page) throw new Error('status page not found');
      if (input.slug !== undefined && st.pages.some((p) => p.slug === input.slug && p.id !== page.id)) {
        throw new Error(`the slug "${input.slug}" is already taken — pick another`);
      }
      if (input.title !== undefined) page.title = input.title;
      if (input.slug !== undefined) {
        page.slug = input.slug;
        page.publicPath = `/s/${input.slug}`;
      }
      if (input.domain !== undefined) page.domain = input.domain?.toLowerCase() ?? null;
      if (input.stackName !== undefined) page.stackName = input.stackName;
      if (input.components !== undefined) page.components = input.components;
      if (input.showUptime !== undefined) page.showUptime = input.showUptime;
      if (input.showIncidents !== undefined) page.showIncidents = input.showIncidents;
      if (input.enabled !== undefined) page.enabled = input.enabled;
      page.updatedAt = nowIso();
      return { ...page };
    },

    'statusPages.remove': (i, s): { id: string; removed: true } => {
      const { id } = i as StatusPageRefInput;
      const st = getState(s);
      st.pages = st.pages.filter((p) => p.id !== id);
      return { id, removed: true };
    },

    'statusPages.setEnabled': (i, s): StatusPageView => {
      const { id, enabled } = i as SetStatusPageEnabledInput;
      const page = getState(s).pages.find((p) => p.id === id);
      if (!page) throw new Error('status page not found');
      page.enabled = enabled;
      page.updatedAt = nowIso();
      return { ...page };
    },
  },

  seed: (store) => {
    const pageId = 'sp-requestflo';
    // Attached to the seeded `storefront` stack so the stack workspace's
    // Observability tab lists it (its components are storefront services).
    const page: StackedPage = {
      id: pageId,
      slug: 'requestflo-status',
      title: 'RequestFlo',
      domain: 'status.requestflo.dev',
      stackName: 'storefront',
      components: [
        { key: 'website', label: 'Website', kind: 'service', ref: 'web' },
        { key: 'api', label: 'API', kind: 'service', ref: 'api' },
        { key: 'checkout', label: 'Checkout', kind: 'service', ref: 'checkout' },
        { key: 'database', label: 'Database', kind: 'db', ref: 'main-db' },
        { key: 'eu-west', label: 'EU region', kind: 'region', ref: 'eu-west' },
      ],
      showUptime: true,
      showIncidents: true,
      enabled: true,
      publicPath: '/s/requestflo-status',
      createdAt: new Date(Date.now() - 120 * DAY_MS).toISOString(),
      updatedAt: new Date(Date.now() - 3 * DAY_MS).toISOString(),
    };

    const incidentOpen = new Date(Date.now() - INCIDENT_DAYS_AGO * DAY_MS + 14 * 3_600_000);
    const minutes = (n: number): string => new Date(incidentOpen.getTime() + n * 60_000).toISOString();

    const state: StatusPagesState = {
      pages: [page],
      uptime: {
        // The API + checkout took the hit on the incident day; the rest were clean.
        [`${pageId}|website`]: genUptime(11, null, 100),
        [`${pageId}|api`]: genUptime(23, INCIDENT_DAYS_AGO, 87.4),
        [`${pageId}|checkout`]: genUptime(37, INCIDENT_DAYS_AGO, 91.2),
        [`${pageId}|database`]: genUptime(53, null, 100),
        [`${pageId}|eu-west`]: genUptime(71, null, 100),
      },
      // checkout is degraded in the live demo world (2 desired / 1 running) —
      // no overrides needed; statuses derive from store.services.
      statuses: {},
      incidents: [
        {
          id: 'inc-demo-api',
          title: 'Elevated API error rate',
          status: 'resolved',
          severity: 'major',
          openedAt: incidentOpen.toISOString(),
          resolvedAt: minutes(38),
          updates: [
            { at: minutes(38), kind: 'resolved', message: 'Error rate back under 0.1% for 15 minutes — resolved.' },
            { at: minutes(21), kind: 'note', message: 'Rolled back api to 2.3.9; error rate falling.' },
            { at: minutes(9), kind: 'alert.fired', message: 'Checkout degraded — upstream API 5xx responses.' },
            { at: minutes(0), kind: 'opened', message: 'API error rate 6.2% (target <1%) after the 2.4.0 rollout.' },
          ],
        },
      ],
    };
    store.extra.statuspages = state;
  },
};
