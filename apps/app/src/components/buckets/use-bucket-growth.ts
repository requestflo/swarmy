import { useQuery } from '@tanstack/react-query';
import type { BucketDetailView } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { bucketGrowth, type BucketGrowth } from './bucket-growth-model';

export type GrowthRead = { state: 'pending' } | { state: 'error' } | { state: 'ready'; growth: BucketGrowth };

/** A week of the bucket's size (`buckets.sizeHistory`) through the forecast rule. */
export function useBucketGrowth(b: BucketDetailView): GrowthRead {
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.buckets.sizeHistory.queryOptions({ bucketId: b.id }), refetchInterval: 5 * 60_000, retry: false });
  if (q.isPending) return { state: 'pending' };
  if (q.isError) return { state: 'error' };
  return { state: 'ready', growth: bucketGrowth(q.data, b.quotas.maxSizeBytes, b.usageBytes) };
}
