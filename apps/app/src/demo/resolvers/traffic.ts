import {
  TRAFFIC_WINDOWS,
  TrafficSeriesInput,
  type TrafficAppView,
  type TrafficEdgeView,
  type TrafficNowView,
  type TrafficRegionView,
  type TrafficSeriesView,
} from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * Per-edge request counting demo (router `traffic`, Q4). Shapes mirror
 * traffic.service.ts exactly. Edges are the Northwind nodes the geo seed marks
 * `swarmy.node.ingress` (read live from the store, so geodns.setNodeRegion
 * moves them): eu-west ≈ 434/min and us-east ≈ 178/min right now (the estate
 * map board), ap-south a trickle, and the draining us-west edge reports
 * nothing yet. Apps: storefront carries most of it, platform
 * (metrics.northwind.dev) a little, and scanner noise lands in "other".
 * Sparklines are a daily curve plus deterministic per-app noise.
 */

/** Requests/min right now per region (the whole region, split over its edges). */
const REGION_RATE: Record<string, number> = { 'eu-west': 434, 'us-east': 178, 'ap-south': 61 };
const DEFAULT_REGION_RATE = 40;

interface DemoApp {
  app: string | null;
  share: number;
  errorShare: number;
  hosts: string[];
}

const APPS: DemoApp[] = [
  {
    app: 'storefront',
    share: 0.87,
    errorShare: 0.004,
    hosts: ['api.northwind.dev', 'cdn.northwind.dev', 'northwind.shop', 'shop.northwind.dev'],
  },
  { app: 'platform', share: 0.08, errorShare: 0, hosts: ['metrics.northwind.dev'] },
  { app: null, share: 0.05, errorShare: 0.02, hosts: ['203.0.113.10', 'scanner.invalid'] },
];

interface DemoEdgeNode {
  id: string;
  name: string;
  status: string;
  labels?: Record<string, string>;
}

function edgesOf(s: DemoStore): Array<{ node: DemoEdgeNode; region: string | null; live: boolean }> {
  return (s.nodes as unknown as DemoEdgeNode[])
    .filter((n) => n.labels?.['swarmy.node.ingress'] === 'true')
    .map((node) => ({ node, region: node.labels?.['swarmy.region'] ?? null, live: node.status === 'online' }));
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Deterministic noise in [-1, 1] for a key (FNV-1a → unit float). */
function noise(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

/** Daily curve: quiet around 04:00 UTC, busiest mid-afternoon; weekends a bit lower. */
function curve(t: number): number {
  const d = new Date(t);
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
  const day = 0.62 + 0.38 * Math.sin(((hour - 9) / 24) * 2 * Math.PI);
  const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6 ? 0.82 : 1;
  return day * weekend;
}

function regionRate(region: string | null): number {
  return region ? (REGION_RATE[region] ?? DEFAULT_REGION_RATE) : DEFAULT_REGION_RATE;
}

function trafficNow(s: DemoStore): TrafficNowView {
  const now = Date.now();
  const edges = edgesOf(s);
  const byRegion = new Map<string | null, typeof edges>();
  for (const e of edges) byRegion.set(e.region, [...(byRegion.get(e.region) ?? []), e]);

  const regions: TrafficRegionView[] = [];
  let total = 0;
  for (const [region, members] of byRegion) {
    const live = members.filter((m) => m.live);
    const rate = regionRate(region);
    const edgeViews: TrafficEdgeView[] = members
      .map((m, i) => ({
        nodeId: m.node.id,
        name: m.node.name,
        region,
        state: m.live ? ('reporting' as const) : ('no-data' as const),
        requestsPerMin: m.live ? round1(rate / live.length + (live.length > 1 ? (i % 2 ? -1 : 1) * 7 : 0)) : null,
        lastReportAt: m.live ? now - 4_000 - i * 1_300 : null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (live.length) total += rate;
    const e5 = live.length ? round1(rate * APPS.reduce((n, a) => n + a.share * a.errorShare, 0)) : null;
    regions.push({
      region,
      requestsPerMin: live.length ? rate : null,
      errors5xxPerMin: e5,
      state: live.length ? 'reporting' : 'no-data',
      edges: edgeViews,
    });
  }
  regions.sort(
    (a, b) => (b.requestsPerMin ?? -1) - (a.requestsPerMin ?? -1) || String(a.region).localeCompare(String(b.region)),
  );

  const apps: TrafficAppView[] = total
    ? APPS.map((a) => {
        const req = round1(total * a.share);
        return {
          app: a.app,
          requestsPerMin: req,
          errors5xxPerMin: round1(req * a.errorShare),
          errorShare: a.errorShare,
          hosts: a.hosts,
        };
      })
    : [];
  const errs = apps.reduce((n, a) => n + a.errors5xxPerMin, 0);
  return {
    sampledAt: total ? now - 4_000 : null,
    windowMinutes: 5,
    unit: 'requests/min',
    totals: {
      requestsPerMin: total ? total : null,
      errors5xxPerMin: total ? round1(errs) : null,
      errorShare: total ? Math.round((errs / total) * 10_000) / 10_000 : null,
      state: total ? 'reporting' : 'no-data',
    },
    regions,
    apps,
  };
}

function trafficSeries(raw: unknown, s: DemoStore): TrafficSeriesView {
  const input = TrafficSeriesInput.parse(raw ?? {});
  const now = Date.now();
  const { spanMs, bucketMs } = TRAFFIC_WINDOWS[input.window];
  const end = Math.floor(now / bucketMs) * bucketMs;
  const start = end - spanMs;

  const live = edgesOf(s).filter((e) => e.live && (!input.region || e.region === input.region));
  const liveRegions = [...new Set(live.map((e) => e.region))];
  const base = liveRegions.reduce((n, r) => n + regionRate(r), 0);
  const app = input.app === undefined ? undefined : APPS.find((a) => a.app === input.app);
  const share = input.app === undefined ? 1 : (app?.share ?? 0);
  const errShare = input.app === undefined ? APPS.reduce((n, a) => n + a.share * a.errorShare, 0) : (app?.errorShare ?? 0);
  // Scale the curve so the newest point sits at today's "now" rate.
  const anchor = curve(now);
  const key = `${input.app === undefined ? '*' : (input.app ?? 'other')}|${input.region ?? '*'}`;

  const points = Array.from({ length: spanMs / bucketMs }, (_, i) => {
    const t = start + i * bucketMs;
    if (base === 0) return { t, requestsPerMin: null, errors5xxPerMin: null };
    const jitter = 1 + 0.09 * noise(`${key}|${Math.floor(t / bucketMs)}`);
    const rate = Math.max(0, base * share * (curve(t) / anchor) * jitter);
    return { t, requestsPerMin: round1(rate), errors5xxPerMin: round1(rate * errShare) };
  });
  return {
    window: input.window,
    bucketSec: bucketMs / 1000,
    unit: 'requests/min',
    ...(input.app !== undefined ? { app: input.app } : {}),
    ...(input.region ? { region: input.region } : {}),
    sampledAt: base ? now - 4_000 : null,
    points,
  };
}

export const traffic: DomainResolvers = {
  handlers: {
    'traffic.now': (_i, s) => trafficNow(s),
    'traffic.series': (i, s) => trafficSeries(i, s),
  },
};
