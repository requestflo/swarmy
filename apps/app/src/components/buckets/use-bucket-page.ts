import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import type { CopyMember } from './bucket-facts';

/**
 * One bucket by name: its detail (grants, attachments), who can reach it,
 * and the servers that keep its copies (`storage.status` members, named
 * from `nodes.list`).
 */
export function useBucketPage(name: string) {
  const trpc = useTRPC();
  const overview = useQuery({ ...trpc.buckets.overview.queryOptions(), refetchInterval: 20_000 });
  const id = overview.data?.buckets.find((b) => b.name === name)?.id;
  const detail = useQuery({ ...trpc.buckets.get.queryOptions({ bucketId: id ?? '' }), enabled: !!id, refetchInterval: 15_000 });
  const access = useQuery({ ...trpc.buckets.access.queryOptions({ bucketId: id ?? '' }), enabled: !!id });
  const config = useQuery(trpc.storage.getConfig.queryOptions());
  const status = useQuery({ ...trpc.storage.status.queryOptions(), refetchInterval: 30_000 });
  const nodes = useQuery(trpc.nodes.list.queryOptions());

  const members: CopyMember[] | undefined =
    status.data && nodes.data
      ? status.data.members.map((m) => {
          const n = nodes.data.find((x) => x.id === m.nodeId);
          return { name: n?.name || n?.hostname || m.nodeId, online: m.online, up: m.up, draining: m.draining };
        })
      : undefined;

  return {
    pending: overview.isPending || (!!id && detail.isPending),
    error: overview.error ?? detail.error,
    retry: () => void Promise.all([overview.refetch(), detail.refetch()]),
    /** The store answered and no bucket has this name. */
    missing: overview.isSuccess && !id,
    store: overview.data,
    bucket: detail.data,
    access: access.data,
    copies: config.data?.replicationFactor,
    members,
  };
}

export type BucketPageData = ReturnType<typeof useBucketPage>;
