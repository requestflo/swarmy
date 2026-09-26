import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import type { AppsBoard } from '@/components/apps/use-apps-board';
import { buildEstate, meshLinks, type RegionGroup } from './estate-model';
import { trafficByRegion, type RegionTraffic } from './map-flows';

export interface EstateMap {
  /** undefined until the servers answer. */
  groups: RegionGroup[] | undefined;
  traffic: Map<string | null, RegionTraffic>;
  links: { a: string; b: string; ok: boolean }[];
  meshOn: boolean;
  /** Sum of every priced server; null when none has a price. */
  monthlyUsd: number | null | undefined;
}

/**
 * The map's data: the Apps board's servers, placement and traffic plus the
 * region coordinates (`geodns.listRegions`), the private network
 * (`mesh.getConfig` + `mesh.listPeers`) and prices (`cost.overview`).
 */
export function useEstateMap(b: AppsBoard): EstateMap {
  const trpc = useTRPC();
  const regions = useQuery({ ...trpc.geodns.listRegions.queryOptions(), refetchInterval: 60_000 });
  const meshCfg = useQuery(trpc.mesh.getConfig.queryOptions());
  const peers = useQuery({ ...trpc.mesh.listPeers.queryOptions(), refetchInterval: 30_000 });
  const cost = useQuery({ ...trpc.cost.overview.queryOptions(), refetchInterval: 60_000 });
  const meshOn = meshCfg.data?.enabled ?? false;

  const groups = React.useMemo(() => {
    if (!b.nodes) return undefined;
    const stackOf = new Map((b.inventory?.services ?? []).map((s) => [s.id, s.stack]));
    return buildEstate({
      nodes: b.nodes,
      apps: b.apps,
      servicesByNode: b.servicesByNode,
      stackOf,
      coords: regions.data,
      meshOn,
      peers: peers.data,
      cost: cost.data,
    });
  }, [b.nodes, b.apps, b.servicesByNode, b.inventory, regions.data, meshOn, peers.data, cost.data]);

  return {
    groups,
    traffic: React.useMemo(() => trafficByRegion(b.traffic), [b.traffic]),
    links: React.useMemo(() => (groups ? meshLinks(groups) : []), [groups]),
    meshOn,
    monthlyUsd: cost.data ? (cost.data.totals.pricedNodes ? cost.data.totals.monthlyUsd : null) : undefined,
  };
}
