import { useQueries } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { composeItem } from './compose-item';
import type { DataItem } from './estate-data';

/**
 * Databases each app runs from its own compose file (MySQL, ClickHouse, a
 * plain Postgres…), from the same `studio.targets` the app's Studio lists.
 * Managed clusters are already in the estate list, so only `compose` ones.
 */
export function useComposeStores(apps: string[]): DataItem[] {
  const trpc = useTRPC();
  const targets = useQueries({
    queries: apps.map((stack) => ({ ...trpc.studio.targets.queryOptions({ stack }), staleTime: 30_000 })),
  });
  return apps.flatMap((app, i) =>
    (targets[i]?.data ?? []).filter((t) => t.kind === 'compose').map((t) => composeItem(app, t)),
  );
}
