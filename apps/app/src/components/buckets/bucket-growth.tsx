import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { BucketDetailView } from '@swarmy/core';
import { TextSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { bucketGrowth, growthWords } from './bucket-growth-model';

/**
 * "+310 MB this week · full in ~20 months" on the bucket's size row (board
 * 42), from `buckets.sizeHistory`. Under 3 days of readings it says so
 * instead of guessing; a fill date shows only while the size is going up
 * and the bucket has a limit.
 */
export function BucketGrowth({ bucket: b }: { bucket: BucketDetailView }): React.JSX.Element {
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.buckets.sizeHistory.queryOptions({ bucketId: b.id }), refetchInterval: 5 * 60_000, retry: false });
  if (q.isPending) return <TextSkeleton className="h-3.5 w-40" />;
  if (q.isError) return <span>growth unavailable just now</span>;
  const limit = b.quotas.maxSizeBytes;
  const g = bucketGrowth(q.data, limit, b.usageBytes);
  const w = growthWords(g, limit !== null);
  return (
    <>
      <span className={g.kind === 'trend' && g.weekBytes > 0 ? 'text-foreground' : undefined}>{w.change}</span>
      {w.forecast ? <span className={g.kind === 'trend' && g.fullInDays !== null && g.fullInDays < 30 ? 'text-tone-warn' : undefined}>{w.forecast}</span> : null}
    </>
  );
}
