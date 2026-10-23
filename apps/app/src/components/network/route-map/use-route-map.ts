import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAppPlacement } from '@/components/apps/use-app-placement';
import { useTRPC } from '@/integrations/trpc';
import type { HubDomain } from '../use-network';
import { buildRouteMap, type RouteMap } from './route-map-model';

/**
 * The route map's live inputs: `traffic.now` (edges, their rate, visitors by
 * region), the servers (status, public IP) and where each service runs.
 * Undefined until traffic and the servers have answered; never a fake zero.
 */
export function useRouteMap(domains: HubDomain[]): { map: RouteMap | undefined; error: unknown; retry: () => void } {
  const trpc = useTRPC();
  const traffic = useQuery({ ...trpc.traffic.now.queryOptions(), refetchInterval: 15_000 });
  const placement = useAppPlacement(undefined);
  const map = React.useMemo(
    () =>
      traffic.data && placement.nodes
        ? buildRouteMap({ domains, traffic: traffic.data, nodes: placement.nodes, servicesByNode: placement.servicesByNode })
        : undefined,
    [domains, traffic.data, placement.nodes, placement.servicesByNode],
  );
  return { map, error: traffic.error, retry: () => void traffic.refetch() };
}
