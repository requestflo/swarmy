import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { InvContainer } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';

/**
 * Live containers for one service, derived from the same `inventory.get` poll
 * the canvas rides — no dedicated per-service procedure needed. `undefined`
 * while the first inventory snapshot loads; `[]` once loaded with none running.
 *
 * `serviceIdOrName` resolves by Docker service id OR service name, mirroring the
 * server's `liveService` lookup: the post-deploy redirect (`services.create`
 * returns the name until inventory catches up) lands on `/services/<name>`, and
 * matching on id alone left the Containers panel empty while the hero said 1/1.
 */
export function useServiceContainers(serviceIdOrName: string): InvContainer[] | undefined {
  const trpc = useTRPC();
  const inventory = useQuery({ ...trpc.inventory.get.queryOptions(), refetchInterval: 3_000 });
  return React.useMemo(() => {
    if (!inventory.data) return undefined;
    const all = inventory.data.services;
    const svc =
      all.find((s) => s.id === serviceIdOrName) ?? all.find((s) => s.name === serviceIdOrName);
    return svc?.containers ?? [];
  }, [inventory.data, serviceIdOrName]);
}
