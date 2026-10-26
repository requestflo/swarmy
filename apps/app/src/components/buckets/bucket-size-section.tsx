import * as React from 'react';
import type { BucketDetailView } from '@swarmy/core';
import { Depth, Section, Tech } from '@/components/calm';
import { quotaPct } from './bucket-facts';
import { BucketForecast, BucketGrowthChange } from './bucket-growth';
import { BucketQuotaField } from './bucket-quota-field';
import { fmtBytes, fmtCount } from './format';
import { useBucketGrowth } from './use-bucket-growth';

/** Size: what it holds against its limit, how many files, how fast it grows and when it reaches its limit. The limit's knobs are at Controls. */
export function BucketSizeSection({ bucket: b }: { bucket: BucketDetailView }): React.JSX.Element {
  const max = b.quotas.maxSizeBytes;
  const pct = quotaPct(b.usageBytes, max);
  const growth = useBucketGrowth(b);
  return (
    <Section
      title="Size"
      action={
        <span className="font-mono text-[13px]">
          {fmtBytes(b.usageBytes)}
          {max ? <span className="text-muted-foreground"> of {fmtBytes(max)} limit</span> : null}
        </span>
      }
    >
      {pct !== null ? (
        <div
          role="meter"
          aria-label="Space used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          className="bg-muted h-2.5 overflow-hidden rounded-full"
        >
          <div className={pct >= 90 ? 'bg-status-warning h-full' : 'bg-primary h-full'} style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      <div className="text-muted-foreground flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11.5px]">
        <span>{b.objects.toLocaleString()} file{b.objects === 1 ? '' : 's'}</span>
        <BucketGrowthChange read={growth} />
        {b.quotas.maxObjects !== null ? <span>at most {fmtCount(b.quotas.maxObjects)} files</span> : null}
        {max === null ? <span>no size limit</span> : <span>writes stop at the limit; reads never do</span>}
      </div>
      <BucketForecast read={growth} />
      <Tech>
        {b.unfinishedUploads} unfinished upload{b.unfinishedUploads === 1 ? '' : 's'} · garage bucket {b.id.slice(0, 16)}… · growth:
        buckets.sizeHistory (telemetry.db, 7 days)
      </Tech>
      <Depth at="controls">
        <BucketQuotaField bucketId={b.id} quotas={b.quotas} />
      </Depth>
    </Section>
  );
}
