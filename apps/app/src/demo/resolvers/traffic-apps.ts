import type { TrafficEdgeView, TrafficHostView } from '@swarmy/core';

/**
 * Who the demo's visits are for: each app's share of the edge traffic and,
 * inside it, each address's share. storefront carries most of it (shop ≈
 * 350/min, the board's 348), platform (metrics.northwind.dev) a little, and
 * scanner noise lands in "other". northwind.shop is still waiting on its DNS,
 * so the edges don't serve it and it has no visits yet.
 */

export interface DemoApp {
  app: string | null;
  share: number;
  errorShare: number;
  /** [host, share of the app's visits]; shares add up to 1. */
  hosts: Array<[string, number]>;
}

export const APPS: DemoApp[] = [
  {
    app: 'storefront',
    share: 0.87,
    errorShare: 0.004,
    hosts: [
      ['shop.northwind.dev', 0.6],
      ['api.northwind.dev', 0.32],
      ['web-store.203-0-113-10.sslip.io', 0.08],
    ],
  },
  { app: 'platform', share: 0.08, errorShare: 0, hosts: [['metrics.northwind.dev', 1]] },
  {
    app: null,
    share: 0.05,
    errorShare: 0.02,
    hosts: [
      ['203.0.113.10', 0.7],
      ['scanner.invalid', 0.3],
    ],
  },
];

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Each address's rate, split over the edges that are reporting (mirrors aggregateTrafficHosts). */
export function demoHosts(edges: TrafficEdgeView[]): TrafficHostView[] {
  const live = edges.filter((e) => e.requestsPerMin !== null);
  return APPS.flatMap((a) =>
    a.hosts.map(([host, share]) => {
      const perEdge = live
        .map((e) => ({ nodeId: e.nodeId, requestsPerMin: round1(e.requestsPerMin! * a.share * share) }))
        .sort((x, y) => y.requestsPerMin - x.requestsPerMin);
      const req = round1(perEdge.reduce((n, e) => n + e.requestsPerMin, 0));
      return {
        host,
        app: a.app,
        requestsPerMin: req,
        errors5xxPerMin: round1(req * a.errorShare),
        errorShare: req > 0 ? a.errorShare : null,
        edges: perEdge,
      };
    }),
  )
    .filter((h) => h.edges.length > 0)
    .sort((x, y) => y.requestsPerMin - x.requestsPerMin || x.host.localeCompare(y.host));
}
