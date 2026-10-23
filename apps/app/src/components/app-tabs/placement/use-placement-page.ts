import * as React from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { NodeSummary } from '@swarmy/core';
import { useAppPlacement as useEstatePlacement } from '@/components/apps/use-app-placement';
import { isNat } from '@/components/nodes/servers/fleet/fleet-model';
import { useTRPC } from '@/integrations/trpc';
import { useAppPlacement, type PlacedService } from '../scaling/use-app-placement';
import { buildMap, partsById, type MapRegion } from './map-model';

export interface PlacementPage {
  rows: PlacedService[] | undefined;
  nodes: NodeSummary[] | undefined;
  picked: PlacedService | undefined;
  pick: (id: string) => void;
  /** Regions declared for the picked part (`swarmy.region.<r>.replicas`), region → copies; undefined while loading. */
  declared: Map<string, number> | undefined;
  /** Every region a server is labelled with, plus declared ones. */
  known: string[] | undefined;
  /** Servers by region with this app's parts on each; undefined until every server answered. */
  map: MapRegion[] | undefined;
}

/** Everything Placement & volumes reads, from queries Scaling and Apps already share. */
export function usePlacementPage(stack: string): PlacementPage {
  const trpc = useTRPC();
  const { rows, nodes } = useAppPlacement(stack);
  const inventory = useQuery({ ...trpc.inventory.get.queryOptions(), refetchInterval: 4_000 });
  const { servicesByNode } = useEstatePlacement(inventory.data);
  const [pickedId, setPickedId] = React.useState<string | null>(null);
  const picked = rows?.find((r) => r.inv.id === pickedId) ?? rows?.find((r) => r.inv.mode === 'replicated') ?? rows?.[0];
  const id = picked?.inv.id ?? '';
  const plan = useQuery({ ...trpc.region.get.queryOptions({ serviceId: id }), enabled: !!id, refetchInterval: 5_000 });
  const knownQ = useQuery({ ...trpc.region.knownRegions.queryOptions(), refetchInterval: 30_000 });
  const declared = React.useMemo(() => (plan.data ? new Map(plan.data.regions.filter((r) => r.replicas > 0).map((r) => [r.region, r.replicas])) : undefined), [plan.data]);
  const known = React.useMemo(
    () => (knownQ.data ? [...new Set([...knownQ.data, ...(declared?.keys() ?? [])])].sort() : undefined),
    [knownQ.data, declared],
  );
  // NAT is a server label; nodes.get per server is the Servers map's own (shared) read.
  const details = useQueries({ queries: (nodes ?? []).map((n) => ({ ...trpc.nodes.get.queryOptions({ id: n.id }), refetchInterval: 60_000 })) });
  const natKey = details.map((d) => (d.data && isNat(d.data.labels) ? d.data.id : '')).join('|');
  const map = React.useMemo(
    () =>
      nodes && servicesByNode && inventory.data
        ? buildMap(nodes.filter((n) => n.status !== 'offline'), servicesByNode, partsById(inventory.data.services, stack), new Set(natKey.split('|').filter(Boolean)))
        : undefined,
    [nodes, servicesByNode, inventory.data, stack, natKey],
  );
  return { rows, nodes, picked, pick: setPickedId, declared: plan.isError ? new Map() : declared, known, map };
}
