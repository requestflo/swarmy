import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { UNGROUPED } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';

/**
 * Docker service name → stack name, derived client-side from the live
 * inventory. Powers stack chips on alert rows that only carry a bare
 * `service:<name>` resource string — no backend stack-scoping needed.
 */
export function useServiceStackMap(): Map<string, string> {
  const trpc = useTRPC();
  const inventory = useQuery({
    ...trpc.inventory.get.queryOptions(),
    refetchInterval: 30_000,
  });
  return useMemo(() => {
    const map = new Map<string, string>();
    for (const s of inventory.data?.services ?? []) {
      if (s.stack && s.stack !== UNGROUPED) map.set(s.name, s.stack);
    }
    return map;
  }, [inventory.data]);
}

/** Resolve a `service:<name>` resource string to its stack, if derivable. */
export function stackForResource(resource: string, map: Map<string, string>): string | null {
  if (!resource.startsWith('service:')) return null;
  return map.get(resource.slice('service:'.length)) ?? null;
}
