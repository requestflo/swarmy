import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { InvService } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';

/**
 * One app's live services off the same `inventory.get` poll the workspace
 * header rides (shared cache, no extra request). `undefined` until the first
 * snapshot lands, so callers never show a fake zero.
 */
export function useStackServices(stack: string): { services: InvService[] | undefined; error: unknown } {
  const trpc = useTRPC();
  const inventory = useQuery({ ...trpc.inventory.get.queryOptions(), refetchInterval: 4_000 });
  const services = React.useMemo(
    () => inventory.data?.services.filter((s) => s.stack === stack && !s.regionParent),
    [inventory.data, stack],
  );
  return { services, error: inventory.error };
}

/** `storefront_web` → `web`: the name people use inside their app. */
export function shortName(stack: string, name: string): string {
  return name.startsWith(`${stack}_`) ? name.slice(stack.length + 1) : name;
}
