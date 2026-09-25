import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Inventory } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { computeStackStats, type StackStat } from '@/components/canvas/stack-aggregates';
import { appWords, type AppWords } from './app-words';

export interface AppItem {
  name: string;
  stat: StackStat;
  words: AppWords;
  /** First address routed to the app (null = none yet). */
  host: string | null;
  /** Every routed host, for the Controls line. */
  hosts: string[];
}

export interface AppsState {
  pending: boolean;
  error: unknown;
  refetch: () => void;
  inventory: Inventory | undefined;
  /** Apps people deployed (the swarmy-system plumbing is `platform`). */
  apps: AppItem[];
  platform: AppItem[];
}

/**
 * Every app with its plain words and address — the one source for the
 * Overview's "Your apps", the Apps list and the app header. Pending until the
 * inventory lands (never a fake zero); addresses fill in when they arrive.
 */
export function useApps(): AppsState {
  const trpc = useTRPC();
  const inventory = useQuery({ ...trpc.inventory.get.queryOptions(), refetchInterval: 4_000 });
  const domains = useQuery({ ...trpc.ingress.listDomains.queryOptions(), refetchInterval: 15_000 });

  const items = React.useMemo(() => {
    if (!inventory.data) return [];
    const byStack = new Map<string, string[]>();
    for (const d of domains.data ?? []) byStack.set(d.stack, [...(byStack.get(d.stack) ?? []), d.host]);
    return computeStackStats(inventory.data).map((stat) => {
      const hosts = byStack.get(stat.name) ?? [];
      return { name: stat.name, stat, words: appWords(stat), host: hosts[0] ?? null, hosts };
    });
  }, [inventory.data, domains.data]);

  return {
    pending: !inventory.data && !inventory.isError,
    error: inventory.isError ? inventory.error : null,
    refetch: () => void inventory.refetch(),
    inventory: inventory.data,
    apps: items.filter((a) => !a.stat.system),
    platform: items.filter((a) => a.stat.system),
  };
}
