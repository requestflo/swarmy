import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { InvContainer } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';

/**
 * Live containers for one service, derived from the same `inventory.get` poll
 * the canvas rides — no dedicated per-service procedure needed. `undefined`
 * while the first inventory snapshot loads; `[]` once loaded with none running.
 */
export function useServiceContainers(serviceId: string): InvContainer[] | undefined {
  const trpc = useTRPC();
  const inventory = useQuery({ ...trpc.inventory.get.queryOptions(), refetchInterval: 3_000 });
  return React.useMemo(() => {
    if (!inventory.data) return undefined;
    return inventory.data.services.find((s) => s.id === serviceId)?.containers ?? [];
  }, [inventory.data, serviceId]);
}
