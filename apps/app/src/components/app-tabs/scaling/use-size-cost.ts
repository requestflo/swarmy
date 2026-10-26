import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { sizeCostBasis, type SizeCostBasis } from './size-cost';

/**
 * The servers' monthly prices behind "≈ $4/mo on these servers"
 * (`cost.overview`, the Cost page's own read; prices change rarely, so it is
 * read every few minutes). `hostIds`: the servers the service's copies run
 * on. undefined while loading, null with no priced server.
 */
export function useSizeCost(hostIds: readonly string[] | undefined): SizeCostBasis | null | undefined {
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.cost.overview.queryOptions(), staleTime: 5 * 60_000, refetchInterval: 5 * 60_000 });
  const key = hostIds?.join(',');
  return React.useMemo(() => {
    if (q.isError) return null;
    if (!q.data || hostIds === undefined) return undefined;
    return sizeCostBasis(q.data.nodes, hostIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for hostIds
  }, [q.data, q.isError, key]);
}
