import { useQueries, useQuery } from '@tanstack/react-query';
import type { BucketDetailView } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { shortName } from '../use-stack-services';

export interface AppBuckets {
  /** Buckets wired to this app's parts; undefined while loading. */
  buckets: Array<{ bucket: BucketDetailView; parts: string[] }> | undefined;
  /** Copies of every file (the store's replication factor). */
  copies: number | undefined;
  /** Names of the servers that keep the copies. */
  servers: string[] | undefined;
}

/**
 * The buckets this app uses (`buckets.get` attachments for its stack) and
 * how the object store keeps them: the replication factor and its member
 * servers — the same reads as the bucket page.
 */
export function useAppBuckets(stack: string): AppBuckets {
  const trpc = useTRPC();
  const overview = useQuery({ ...trpc.buckets.overview.queryOptions(), refetchInterval: 30_000 });
  const ids = overview.data?.state === 'ready' ? overview.data.buckets.map((b) => b.id) : [];
  const details = useQueries({ queries: ids.map((bucketId) => ({ ...trpc.buckets.get.queryOptions({ bucketId }), refetchInterval: 30_000 })) });
  const config = useQuery(trpc.storage.getConfig.queryOptions());
  const status = useQuery({ ...trpc.storage.status.queryOptions(), refetchInterval: 30_000 });
  const nodes = useQuery(trpc.nodes.list.queryOptions());
  const settled = overview.data !== undefined && details.every((d) => d.data !== undefined || d.isError);
  const buckets = settled
    ? details
        .map((d) => d.data)
        .filter((b): b is BucketDetailView => !!b)
        .map((bucket) => ({ bucket, parts: [...new Set(bucket.attachments.filter((a) => a.stack === stack).map((a) => shortName(stack, a.service)))].sort() }))
        .filter((b) => b.parts.length > 0)
    : overview.isError
      ? []
      : undefined;
  const servers = status.data && nodes.data ? status.data.members.map((m) => nodes.data.find((n) => n.id === m.nodeId)?.name ?? m.nodeId) : undefined;
  return { buckets, copies: config.data?.replicationFactor, servers };
}
