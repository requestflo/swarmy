import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';

export interface StackServiceNames {
  /** Plain, de-prefixed names for pickers (`web`, not `storefront_web`). */
  names: string[];
  /** Membership test tolerant of both full and de-prefixed OTel service names. */
  has: (serviceName: string) => boolean;
  isLoading: boolean;
}

const NO_NAMES: string[] = [];

/**
 * The service names living in one stack, read from the live inventory. OTel
 * `service.name` may be the full Docker name (`storefront_web`) or the compose
 * short name (`web`), so membership accepts either spelling.
 */
export function useStackServiceNames(stack: string | undefined): StackServiceNames {
  const trpc = useTRPC();
  const inventory = useQuery({
    ...trpc.inventory.get.queryOptions(),
    enabled: Boolean(stack),
    refetchInterval: 10_000,
  });

  const { names, all } = React.useMemo(() => {
    if (!stack || !inventory.data) return { names: NO_NAMES, all: new Set<string>() };
    const plain: string[] = [];
    const set = new Set<string>();
    for (const svc of inventory.data.services) {
      if (svc.stack !== stack) continue;
      set.add(svc.name);
      const prefix = `${stack}_`;
      const short = svc.name.startsWith(prefix) ? svc.name.slice(prefix.length) : svc.name;
      set.add(short);
      plain.push(short);
    }
    return { names: plain.sort(), all: set };
  }, [stack, inventory.data]);

  const has = React.useCallback((serviceName: string): boolean => all.has(serviceName), [all]);

  return { names, has, isLoading: Boolean(stack) && inventory.isLoading };
}
