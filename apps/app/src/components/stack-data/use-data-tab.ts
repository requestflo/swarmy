import { useQuery } from '@tanstack/react-query';
import type { CacheClusterView, SearchInstanceView, VectorInstanceView } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import type { PgBackupFacts } from './pg-choices';
import type { PgCluster } from './pg-ha-section';

export interface DataTabData {
  pending: boolean;
  error: string | null;
  clusters: PgCluster[];
  backups: Record<string, PgBackupFacts>;
  caches: CacheClusterView[];
  search: SearchInstanceView[];
  vectors: VectorInstanceView[];
}

/**
 * Every managed data service one app uses, from the same queries the
 * sections poll (TanStack dedupes them), so the headline and the rows can
 * never disagree.
 */
export function useDataTab(stack: string): DataTabData {
  const trpc = useTRPC();
  const db = useQuery({ ...trpc.db.get.queryOptions({ stack }), refetchInterval: 4_000 });
  const overview = useQuery({ ...trpc.dbBackups.overview.queryOptions(), refetchInterval: 30_000 });
  const cache = useQuery({ ...trpc.cache.list.queryOptions({ stack }), refetchInterval: 5_000 });
  const search = useQuery({ ...trpc.search.list.queryOptions({ stack }), refetchInterval: 5_000 });
  const vector = useQuery({ ...trpc.vector.list.queryOptions({ stack }), refetchInterval: 5_000 });

  const backups: Record<string, PgBackupFacts> = {};
  for (const row of overview.data ?? []) if (row.stack === stack) backups[row.cluster] = row;

  const all = [db, cache, search, vector];
  return {
    pending: all.some((q) => q.isPending),
    error: db.error?.message ?? null,
    clusters: (db.data?.clusters ?? []) as PgCluster[],
    backups,
    caches: cache.data ?? [],
    search: search.data ?? [],
    vectors: vector.data ?? [],
  };
}
