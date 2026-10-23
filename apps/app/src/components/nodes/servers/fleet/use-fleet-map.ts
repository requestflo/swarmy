import * as React from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { Inventory } from '@swarmy/core';
import { useAppPlacement } from '@/components/apps/use-app-placement';
import { useTRPC } from '@/integrations/trpc';
import type { Fleet } from '../use-fleet';
import { buildFleet, fleetLinks, type FleetGroup, type FleetView } from './fleet-model';

export interface FleetMap {
  /** undefined until the servers answer. */
  groups: FleetGroup[] | undefined;
  byId: Map<string, FleetView>;
  links: { a: string; b: string; ok: boolean }[];
  meshOn: boolean;
  inventory: Inventory | undefined;
}

/**
 * The Servers map's data on top of `useFleet`: region coordinates
 * (`geodns.listRegions`), the private network (`mesh.getConfig` +
 * `mesh.listPeers`), each server's labels for the NAT badge (`nodes.get`),
 * and what runs where (`services.list({ nodeId })` folded onto the live
 * inventory, the Apps map's placement).
 */
export function useFleetMap(fleet: Fleet): FleetMap {
  const trpc = useTRPC();
  const regions = useQuery({ ...trpc.geodns.listRegions.queryOptions(), refetchInterval: 60_000 });
  const meshCfg = useQuery(trpc.mesh.getConfig.queryOptions());
  const peers = useQuery({ ...trpc.mesh.listPeers.queryOptions(), refetchInterval: 30_000 });
  const inventory = useQuery({ ...trpc.inventory.get.queryOptions(), refetchInterval: 4_000 });
  const placement = useAppPlacement(inventory.data);
  const details = useQueries({
    queries: fleet.servers.map((s) => ({ ...trpc.nodes.get.queryOptions({ id: s.node.id }), refetchInterval: 60_000 })),
  });
  const labelsKey = details.map((d) => d.dataUpdatedAt).join('|');
  const meshOn = meshCfg.data?.enabled ?? false;

  const groups = React.useMemo(() => {
    if (fleet.pending) return undefined;
    const labelsOf = new Map(details.flatMap((d) => (d.data ? [[d.data.id, d.data.labels ?? {}] as const] : [])));
    return buildFleet({
      servers: fleet.servers,
      coords: regions.data,
      meshOn,
      peers: peers.data,
      labelsOf,
      servicesByNode: placement.servicesByNode,
      inventory: inventory.data,
    });
    // labelsKey stands in for the per-server detail identities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fleet, regions.data, meshOn, peers.data, labelsKey, placement.servicesByNode, inventory.data]);

  return {
    groups,
    byId: React.useMemo(() => new Map((groups ?? []).flatMap((g) => g.servers.map((s) => [s.server.node.id, s] as const))), [groups]),
    links: React.useMemo(() => (groups && meshOn ? fleetLinks(groups) : []), [groups, meshOn]),
    meshOn,
    inventory: inventory.data,
  };
}
