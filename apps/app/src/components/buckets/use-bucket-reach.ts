import { useQueries } from '@tanstack/react-query';
import type { inferOutput } from '@trpc/tanstack-react-query';
import { useTRPC } from '@/integrations/trpc';

export type BucketAccessView = inferOutput<ReturnType<typeof useTRPC>['buckets']['access']>;

/** Who can reach each bucket (`buckets.access` per bucket): bucket id → its view, once loaded. */
export function useBucketReach(bucketIds: string[]): Map<string, BucketAccessView> {
  const trpc = useTRPC();
  const access = useQueries({
    queries: bucketIds.map((bucketId) => ({ ...trpc.buckets.access.queryOptions({ bucketId }), refetchInterval: 30_000 })),
  });
  const out = new Map<string, BucketAccessView>();
  bucketIds.forEach((id, i) => {
    const v = access[i]?.data;
    if (v) out.set(id, v);
  });
  return out;
}
