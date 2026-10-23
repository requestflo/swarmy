import type { NodeSummary } from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * Config › Placement & volumes' demo world (board AppPlacement). Per-region
 * copies mirror `region.service.ts`: a part declares
 * `swarmy.region.<region>.replicas` (kept here per service), known regions
 * are the servers' `swarmy.region` labels plus declared ones, and the plan
 * reports each declared region's copies — the demo materialises them at
 * once. storefront's web keeps a render cache in an anonymous volume, so
 * "Make durable" has something to name.
 */

type Plans = Record<string, Record<string, number>>;

const plans = (store: DemoStore): Plans => (store.extra.regionPlans ??= {}) as Plans;

function knownRegions(store: DemoStore): string[] {
  const out = new Set<string>();
  for (const n of store.nodes as NodeSummary[]) if (n.region) out.add(n.region);
  for (const p of Object.values(plans(store))) for (const r of Object.keys(p)) out.add(r);
  return [...out].sort();
}

function serviceOf(store: DemoStore, id: string) {
  const sv = store.services.find((s) => s.id === id || s.name === id);
  if (!sv) throw new Error(`service "${id}" not found`);
  return sv;
}

export const placementDemo: DomainResolvers = {
  seed: (store) => {
    const web = store.services.find((s) => s.id === 'svc-web');
    if (web && !web.volumes.some((v) => v.target === '/app/.cache')) web.volumes = [...web.volumes, { type: 'volume', target: '/app/.cache', readOnly: false }];
  },
  handlers: {
    'region.knownRegions': (_i, store) => knownRegions(store),
    'region.get': (i, store) => {
      const sv = serviceOf(store, (i as { serviceId: string }).serviceId);
      const declared = plans(store)[sv.id] ?? {};
      const regions = Object.entries(declared)
        .map(([region, replicas]) => ({ region, replicas }))
        .sort((a, b) => a.region.localeCompare(b.region));
      return {
        serviceId: sv.id,
        serviceName: sv.name,
        regions,
        knownRegions: knownRegions(store),
        desiredTotal: regions.reduce((n, r) => n + r.replicas, 0),
        liveDesired: sv.replicas.desired,
      };
    },
    'region.plan': (i, store) => {
      const sv = serviceOf(store, (i as { serviceId: string }).serviceId);
      return Object.entries(plans(store)[sv.id] ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([region, desired]) => ({ region, desired, running: desired }));
    },
    'region.set': (i, store) => {
      const { serviceId, region, replicas } = i as { serviceId: string; region: string; replicas: number };
      const sv = serviceOf(store, serviceId);
      const p = (plans(store)[sv.id] ??= {});
      if (replicas > 0) p[region] = replicas;
      else delete p[region];
      return { id: sv.id, ok: true as const };
    },
  },
};
