import type { DomainResolvers, DemoStore } from '../types';
import { getState, toZoneView, type DemoNode } from './geo';

/**
 * Cluster-zone demo resolvers — mirror `geodns.clusterZone` /
 * `geodns.setClusterZone` (cluster-zone.service.ts) over the Geo-DNS demo
 * world in geo.ts. The demo starts without one, so Network › Geo-DNS shows
 * apps on their public convenience name (sslip.io) until a zone is picked.
 */

/** The demo edge's address, as the ingress/blueprint demos embed it. */
const DEMO_EDGE_IP = '203.0.113.10';

type Source = 'own-zone' | 'cluster-zone' | 'configured' | 'public-convenience';

function view(store: DemoStore) {
  const st = getState(store);
  const cluster = st.zones.find((z) => z.clusterZone && z.mode === 'swarmy-ns' && z.enabled);
  const own = st.zones.find((z) => z.autoAddresses && z.mode === 'swarmy-ns' && z.enabled);
  const dashed = DEMO_EDGE_IP.replace(/\./g, '-');
  const addressBase = own ? own.zone : cluster ? `${dashed}.${cluster.zone}` : `${dashed}.sslip.io`;
  const source: Source = own ? 'own-zone' : cluster ? 'cluster-zone' : 'public-convenience';
  const ns = cluster ? toZoneView(store, cluster).nameservers : [];
  return {
    zoneId: cluster?.id ?? null,
    zone: cluster?.zone ?? null,
    glue: cluster
      ? [
          ...ns.map((n) => ({ name: cluster.zone, type: 'NS' as const, value: n.fqdn })),
          ...ns.filter((n) => n.ip).map((n) => ({ name: n.fqdn, type: 'A' as const, value: n.ip })),
        ]
      : [],
    addressBase,
    source,
    // The demo's documentation addresses stand in for public ones (the real
    // controller refuses reserved ranges like these).
    synthesized: cluster
      ? [...new Set((store.nodes as DemoNode[]).map((n) => n.publicIp).filter((ip): ip is string => !!ip))].sort()
      : [],
  };
}

export const clusterZone: DomainResolvers = {
  handlers: {
    'geodns.clusterZone': (_i, s) => view(s),

    'geodns.setClusterZone': (i, s) => {
      const { id, enabled } = i as { id: string; enabled: boolean };
      const st = getState(s);
      const z = st.zones.find((x) => x.id === id);
      if (!z) throw new Error(`zone not found: ${id}`);
      if (enabled) {
        if (z.mode !== 'swarmy-ns' || !z.enabled) throw new Error(`${z.zone} must be enabled and served by swarmy's nameservers first`);
        if (z.advertisedNodeIds.length < 2) throw new Error(`${z.zone} is not delegated to swarmy yet (public NS: none).`);
      }
      // One per org: turning one on clears the others.
      if (enabled) for (const other of st.zones) other.clusterZone = other.id === id;
      else z.clusterZone = false;
      st.updatedAt = new Date().toISOString();
      return view(s);
    },
  },
};
