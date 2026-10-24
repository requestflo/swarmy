import type { TrafficAppView, TrafficEdgeView, TrafficNowView, TrafficRegionView } from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';
import { APPS, demoHosts } from './traffic-apps';
import { withDemoExtras } from './traffic-latency';
import { trafficSeries } from './traffic-series';
import { edgesOf, regionRate, round1 } from './traffic-shape';

/**
 * Per-edge request counting demo (router `traffic`, Q4). Shapes mirror
 * traffic.service.ts exactly. Edges are the Northwind nodes the geo seed marks
 * `swarmy.node.ingress` (traffic-shape.ts): eu-west ≈ 434/min and us-east ≈
 * 178/min right now (the estate map board), ap-south a trickle, and the
 * draining us-west edge reports nothing yet. Who the visits are for (per app
 * and per address) lives in traffic-apps.ts; answer times and blocked
 * answers in traffic-latency.ts; sparklines in traffic-series.ts.
 */

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
          hosts: a.hosts.map(([h]) => h).sort(),
        };
      })
    : [];
  const errs = apps.reduce((n, a) => n + a.errors5xxPerMin, 0);
  return withDemoExtras({
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
    hosts: total ? demoHosts(regions.flatMap((r) => r.edges)) : [],
  });
}

export const traffic: DomainResolvers = {
  handlers: {
    'traffic.now': (_i, s) => trafficNow(s),
    'traffic.series': (i, s) => trafficSeries(i, s),
  },
};
