import * as React from 'react';
import type { BucketSummaryView } from '@swarmy/core';
import { BucketRow } from './bucket-row';
import type { ReachMode } from './reach-model';
import { useBucketReach } from './use-bucket-reach';

/** Flat rows in one card (hairline-divided) — name, usage, quota, who can reach it. Each row opens the bucket. */
export function BucketsTable({ buckets }: { buckets: BucketSummaryView[] }): React.JSX.Element {
  const reach = useBucketReach(buckets.map((b) => b.id));
  return (
    <div className="calm-card overflow-hidden">
      <div className="text-muted-foreground mono-label grid grid-cols-[1fr_auto] items-center gap-4 border-b px-5 py-3 sm:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))_auto]">
        <span>Bucket</span>
        <span className="hidden text-right sm:block">Size</span>
        <span className="hidden text-right sm:block">Objects</span>
        <span className="hidden text-right sm:block">Quota</span>
        <span className="text-right">Who can reach it</span>
      </div>
      <div className="divide-border divide-y">
        {buckets.map((b) => (
          <BucketRow key={b.id} bucket={b} reach={reach.get(b.id)?.mode as ReachMode | undefined} />
        ))}
      </div>
    </div>
  );
}
