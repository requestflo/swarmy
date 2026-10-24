import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { countedAtEdge, hostVisits, type HostVisits } from '@/lib/host-visits';
import type { HubDomain } from './use-network';

/**
 * Each address's visits a minute at the edge (`traffic.now.hosts`), for the
 * route map and the domain rows. Same queries as the map and the hub, so
 * nothing is fetched twice. Null = no honest number for that address.
 */
export function useAddressVisits(): (d: HubDomain) => HostVisits | null {
  const trpc = useTRPC();
  const traffic = useQuery({ ...trpc.traffic.now.queryOptions(), refetchInterval: 15_000 });
  const config = useQuery({ ...trpc.ingress.getConfig.queryOptions(), refetchInterval: 10_000 });
  const driver = config.data?.driver;
  return React.useCallback(
    (d: HubDomain) => hostVisits(traffic.data, d.host, countedAtEdge(d.ingressDriver, driver)),
    [traffic.data, driver],
  );
}
