import type { DemoStore, DomainResolvers } from '../types';
import { buildRecording, type DemoRecording } from './rum-replay';

/**
 * Web analytics + session replay demo resolvers (`rum.*`). The storefront app
 * is on in identified mode with a 10% replay sample, so Observability →
 * Analytics / Session replays / settings all render with believable numbers
 * and a playable checkout-failure recording. Other apps start off.
 */

interface RumSettings {
  enabled: boolean;
  mode: 'analytics' | 'identified';
  replaySampleRate: number;
  maskAllText: boolean;
  blockSelectors: string[];
  consent: 'none' | 'hook' | 'cmp';
  retentionDays: number;
  csp: 'rewrite' | 'skip';
}

interface RumRoute {
  service: string;
  host: string;
  path: string;
  override: 'on' | 'off' | null;
  injected: boolean;
}

interface DemoSession {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  events: number;
  bytes: number;
  clicks: number;
  errors: number;
  requests: number;
  chunks: number;
  firstPath: string;
  userId: string;
  country: string;
  device: string;
  browser: string;
}

interface RumState {
  settings: Record<string, RumSettings>;
  routes: Record<string, Omit<RumRoute, 'injected'>[]>;
  sessions: DemoSession[];
  recordings: Record<string, DemoRecording>;
}

const DEFAULTS: RumSettings = {
  enabled: false,
  mode: 'analytics',
  replaySampleRate: 0,
  maskAllText: false,
  blockSelectors: [],
  consent: 'hook',
  retentionDays: 14,
  csp: 'rewrite',
};

const SEED_SESSIONS: Array<[string, string, string, string, string, number, boolean]> = [
  // id, user, country, device, browser, minutes ago, full checkout story
  ['rs7f2a19c0d4e1', 'maria.l@example.com', 'GB', 'mobile', 'Safari 18', 12, true],
  ['rs91cc04a7b2f9', '', 'US', 'desktop', 'Chrome 129', 16, true],
  ['rs2b10ee51c8a3', 'j.chen@example.com', 'DE', 'desktop', 'Firefox 131', 20, false],
  ['rsc4e871f0e62d', '', 'FR', 'mobile', 'Chrome 129', 23, false],
  ['rs5d71a0b93e44', 'a.dubois@example.com', 'FR', 'desktop', 'Safari 18', 31, true],
  ['rse0a3b2d17c58', '', 'NL', 'tablet', 'Safari 18', 35, false],
];

function state(s: DemoStore): RumState {
  return s.extra.rum as RumState;
}

function settingsFor(s: DemoStore, stack: string): RumSettings {
  return state(s).settings[stack] ?? DEFAULTS;
}

function view(s: DemoStore, stack: string) {
  const settings = settingsFor(s, stack);
  const routes = (state(s).routes[stack] ?? []).map((r) => ({
    ...r,
    injected: r.override === 'on' || (r.override !== 'off' && settings.enabled),
  }));
  return { stack, settings, routes, stores: { analytics: true, replay: true } };
}

function recording(s: DemoStore, id: string): DemoRecording | undefined {
  const st = state(s);
  const sess = st.sessions.find((x) => x.sessionId === id);
  if (!sess) return undefined;
  if (!st.recordings[id]) {
    const full = SEED_SESSIONS.find((x) => x[0] === id)?.[6] ?? false;
    const rec = buildRecording(Date.parse(sess.startedAt), id.charCodeAt(3) * 7 + id.length, full);
    rec.events.sort((a, b) => a.timestamp - b.timestamp);
    st.recordings[id] = rec;
  }
  return st.recordings[id];
}

const at = (daysAgo: number): string => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
const bd = (rows: Array<[string, number]>, ratio = 3.9) =>
  rows.map(([key, v]) => ({ key, visitors: v, pageviews: Math.round(v * ratio) }));

function analytics(s: DemoStore, stack: string, days: number) {
  const on = settingsFor(s, stack).enabled;
  const k = on ? Math.max(1, days / 7) : 0;
  const base = [3920, 4110, 3870, 4240, 4460, 4020, 4130];
  const series = Array.from({ length: days }, (_, i) => {
    const v = on ? base[i % 7]! + Math.round(Math.sin(i * 1.7) * 180) : 0;
    return { day: at(days - 1 - i), visitors: v, pageviews: Math.round(v * 3.9) };
  });
  const scale = (rows: Array<[string, number]>) => rows.map(([key, v]) => [key, Math.round(v * k)] as [string, number]);
  const identified = settingsFor(s, stack).mode === 'identified';
  return {
    status: 'ok' as const,
    days,
    kpis: on
      ? { visits: Math.round(28_750 * k), pageviews: Math.round(112_100 * k), bounceRate: 0.38, medianVisitSeconds: 161, signedIn: identified ? Math.round(1840 * k) : 0 }
      : { visits: 0, pageviews: 0, bounceRate: 0, medianVisitSeconds: 0, signedIn: 0 },
    live: on ? { visitors: 37 + (Math.floor(Date.now() / 15_000) % 9), pageviews: 142 } : { visitors: 0, pageviews: 0 },
    series,
    pages: bd(scale([['/', 9800], ['/mugs', 5480], ['/product/pour-over-set', 3280], ['/cart', 2330], ['/checkout', 1620], ['/sale', 1330], ['/about', 540]])),
    referrers: bd(scale([['google.com', 11800], ['', 8400], ['instagram.com', 3100], ['newsletter · listmonk', 2600], ['duckduckgo.com', 1500], ['news.ycombinator.com', 1350]])),
    countries: bd(scale([['GB', 12400], ['US', 7200], ['DE', 2900], ['FR', 2100], ['NL', 1600], ['AU', 900], ['', 310]])),
    devices: bd(scale([['desktop', 15200], ['mobile', 12100], ['tablet', 1450]])),
    browsers: bd(scale([['Chrome', 13100], ['Safari', 10400], ['Firefox', 2900], ['Edge', 1900], ['Samsung Internet', 450]])),
    sources: bd(scale([['newsletter', 2600], ['instagram', 1900], ['autumn-sale', 820]])),
    users: on && identified
      ? state(s).sessions.filter((x) => x.userId).map((x, i) => ({
          userId: x.userId,
          pageviews: 4 + i * 2,
          sessions: 1 + (i % 3),
          lastSeen: x.startedAt,
          country: x.country,
          lastSession: x.sessionId,
        }))
      : [],
  };
}

export const rum: DomainResolvers = {
  seed: (s) => {
    const now = Date.now();
    const sessions: DemoSession[] = SEED_SESSIONS.map(([sessionId, userId, country, device, browser, ago, full]) => {
      const start = now - ago * 60_000;
      const durationMs = full ? 94_000 : 40_000;
      return {
        sessionId, userId, country, device, browser, durationMs,
        startedAt: new Date(start).toISOString(),
        endedAt: new Date(start + durationMs).toISOString(),
        events: full ? 96 : 38,
        bytes: full ? 212_000 : 88_000,
        clicks: full ? 9 : 3,
        errors: full ? 2 : 0,
        requests: full ? 11 : 5,
        chunks: full ? 3 : 1,
        firstPath: '/',
      };
    });
    s.extra.rum = {
      settings: {
        storefront: { ...DEFAULTS, enabled: true, mode: 'identified', replaySampleRate: 0.1, blockSelectors: ['.card-number', '[data-private]', 'iframe'] },
      },
      routes: {
        storefront: [
          { service: 'web', host: 'shop.northwind.dev', path: '/', override: null },
          { service: 'web', host: 'shop.northwind.dev', path: '/checkout', override: null },
          { service: 'web', host: 'shop.northwind.dev', path: '/account', override: 'off' },
          { service: 'api', host: 'api.northwind.dev', path: '/v2', override: 'off' },
        ],
      },
      sessions,
      recordings: {},
    } satisfies RumState;
  },
  handlers: {
    'rum.getSettings': (i, s) => view(s, (i as { stack: string }).stack),
    'rum.setSettings': (i, s) => {
      const { stack, settings } = i as { stack: string; settings: RumSettings };
      state(s).settings[stack] = { ...settings };
      return view(s, stack);
    },
    'rum.setRoute': (i, s) => {
      const { stack, service, host, path, override } = i as Omit<RumRoute, 'injected'> & { stack: string };
      const r = (state(s).routes[stack] ?? []).find((x) => x.service === service && x.host === host && x.path === path);
      if (r) r.override = override;
      return view(s, stack);
    },
    'rum.analytics': (i, s) => {
      const { stack, days } = i as { stack: string; days?: number };
      return analytics(s, stack, days ?? 7);
    },
    'rum.footprint': (i, s) =>
      settingsFor(s, (i as { stack: string }).stack).enabled
        ? { eventRows: 812_400, replaySessions: 2_870, replayBytes: 2_870 * 176_000, replaySessions24h: 412, visitors24h: 4_120 }
        : null,
    'rum.replays': (i, s) => {
      const { stack, withErrors, userId } = i as { stack: string; withErrors?: boolean; userId?: string };
      if (!settingsFor(s, stack).enabled) return { status: 'ok', sessions: [] };
      const list = state(s).sessions.filter((x) => (!withErrors || x.errors > 0) && (!userId || x.userId === userId));
      return { status: 'ok', sessions: list };
    },
    'rum.replay': (i, s) => {
      const { sessionId } = i as { stack: string; sessionId: string };
      const sess = state(s).sessions.find((x) => x.sessionId === sessionId);
      const rec = recording(s, sessionId);
      if (!sess || !rec) {
        return { status: 'not-found', sessionId, meta: null, events: [], requests: [], logs: [], errors: [] };
      }
      const { userId, country, device, browser, startedAt, endedAt } = sess;
      return { status: 'ok', sessionId, meta: { userId, country, device, browser, startedAt, endedAt }, ...rec };
    },
    'rum.deleteSession': (i, s) => {
      const { sessionId } = i as { sessionId: string };
      const st = state(s);
      const before = st.sessions.length;
      st.sessions = st.sessions.filter((x) => x.sessionId !== sessionId);
      delete st.recordings[sessionId];
      return { sessions: before - st.sessions.length, objects: 3 };
    },
    'rum.deleteUser': (i, s) => {
      const { userId } = i as { userId: string };
      const st = state(s);
      const gone = st.sessions.filter((x) => x.userId === userId);
      st.sessions = st.sessions.filter((x) => x.userId !== userId);
      for (const g of gone) delete st.recordings[g.sessionId];
      return { sessions: gone.length, objects: gone.length * 3 };
    },
  },
};
