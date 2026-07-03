import * as React from 'react';
import type { BucketSummaryView } from '@swarmy/core';
import { BucketRow } from './bucket-row';

interface BucketsTableProps {
  buckets: BucketSummaryView[];
  expandedId: string | null;
  onToggle: (id: string) => void;
}

/** Flat rows in one card (hairline-divided) — name, usage, quota, visibility. Clicking a row expands detail inline. */
export function BucketsTable({ buckets, expandedId, onToggle }: BucketsTableProps): React.JSX.Element {
  return (
    <div className="card-pop overflow-hidden">
      <div className="text-muted-foreground mono-label grid grid-cols-[1fr_auto] items-center gap-4 border-b px-5 py-3 sm:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))_auto]">
        <span>Bucket</span>
        <span className="hidden text-right sm:block">Size</span>
        <span className="hidden text-right sm:block">Objects</span>
        <span className="hidden text-right sm:block">Quota</span>
        <span className="text-right">Access</span>
      </div>
      <div className="divide-border divide-y">
        {buckets.map((b) => (
          <BucketRow
            key={b.id}
            bucket={b}
            expanded={expandedId === b.id}
            onToggle={() => onToggle(b.id)}
            onDeleted={() => onToggle(b.id)}
          />
        ))}
      </div>
    </div>
  );
}
