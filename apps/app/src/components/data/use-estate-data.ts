import { useQueries, useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { bucketItem, cacheItem, indexItem, pgItem, type DataItem } from './estate-data';

/** Every database, cache, index and bucket across the apps, from the same queries each app's Data tab polls. */
export function useEstateData() {
  const trpc = useTRPC();
  const pg = useQuery({ ...trpc.dbBackups.overview.queryOptions(), refetchInterval: 30_000 });
  const cache = useQuery({ ...trpc.cache.list.queryOptions(), refetchInterval: 15_000 });
  const search = useQuery(trpc.search.list.queryOptions());
  const vector = useQuery(trpc.vector.list.queryOptions());
  const buckets = useQuery(trpc.buckets.overview.queryOptions());
  const storage = useQuery(trpc.storage.getConfig.queryOptions());
  const bucketRows = buckets.data?.buckets ?? [];
  const details = useQueries({
    queries: bucketRows.map((b) => trpc.buckets.get.queryOptions({ bucketId: b.id })),
  });

  const copies = storage.data?.replicationFactor ?? 1;
  const items: DataItem[] = [
    ...(pg.data ?? []).map(pgItem),
    ...(cache.data ?? []).map(cacheItem),
    ...(search.data ?? []).map((s) => indexItem('Search', s)),
    ...(vector.data ?? []).map((v) => indexItem('Vectors', { stack: v.stack, name: v.name, engine: v.kind })),
    ...bucketRows.map((b, i) => {
      const owner = details[i]?.data?.attachments[0]?.stack ?? 'Shared';
      return bucketItem(b, owner, copies);
    }),
  ];
  const apps = [...new Set(items.map((i) => i.app))].sort((a, b) => (a === 'Shared' ? 1 : b === 'Shared' ? -1 : a.localeCompare(b)));
  const worst = [...items].sort((a, b) => b.risk - a.risk)[0];
  return {
    ready: pg.isSuccess && cache.isSuccess && buckets.isSuccess,
    error: pg.error ?? cache.error ?? buckets.error,
    retry: () => void Promise.all([pg.refetch(), cache.refetch(), buckets.refetch()]),
    items,
    apps,
    worst: worst && worst.risk >= 50 ? worst : undefined,
    pgRows: pg.data ?? [],
    bucketStore: buckets.data,
    copies,
  };
}

export type EstateData = ReturnType<typeof useEstateData>;
