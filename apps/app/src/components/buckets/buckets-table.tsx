import * as React from 'react';
import { GlobeIcon, KeyIcon, LockIcon } from 'lucide-react';
import type { BucketSummaryView } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { fmtBytes, fmtCount } from './format';

interface BucketsTableProps {
  buckets: BucketSummaryView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/** Flat rows in one card (hairline-divided) — name, usage, quota, visibility. */
export function BucketsTable({ buckets, selectedId, onSelect }: BucketsTableProps): React.JSX.Element {
  return (
    <div className="card-pop overflow-hidden">
      <div className="text-muted-foreground mono-label grid grid-cols-[1fr_auto] items-center gap-4 border-b px-5 py-3 sm:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))_auto]">
        <span>Bucket</span>
        <span className="hidden text-right sm:block">Size</span>
        <span className="hidden text-right sm:block">Objects</span>
        <span className="hidden text-right sm:block">Quota</span>
        <span className="text-right">Access</span>
      </div>
      <ul className="divide-border divide-y">
        {buckets.map((b) => (
          <li key={b.id}>
            <button
              type="button"
              onClick={() => onSelect(b.id)}
              className={cn(
                'hover:bg-accent/50 grid w-full grid-cols-[1fr_auto] items-center gap-4 px-5 py-3.5 text-left transition-colors sm:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))_auto]',
                selectedId === b.id && 'bg-accent border-l-primary border-l-[3px] pl-[17px]',
              )}
            >
              <span className="min-w-0">
                <span className="mono-data block truncate font-medium">{b.name}</span>
                <span className="text-muted-foreground text-xs sm:hidden">
                  {fmtBytes(b.usageBytes)} · {fmtCount(b.objects)} objects
                </span>
              </span>
              <span className="mono-data hidden text-right sm:block">{fmtBytes(b.usageBytes)}</span>
              <span className="mono-data hidden text-right sm:block">{fmtCount(b.objects)}</span>
              <span className="mono-data text-muted-foreground hidden text-right text-xs sm:block">
                {b.quotas.maxSizeBytes !== null || b.quotas.maxObjects !== null ? (
                  <>
                    {b.quotas.maxSizeBytes !== null ? fmtBytes(b.quotas.maxSizeBytes) : '∞'}
                    {' / '}
                    {b.quotas.maxObjects !== null ? fmtCount(b.quotas.maxObjects) : '∞'}
                  </>
                ) : (
                  'none'
                )}
              </span>
              <span className="flex items-center justify-end gap-2">
                <span className="text-muted-foreground mono-data hidden items-center gap-1 text-xs lg:inline-flex">
                  <KeyIcon className="size-3.5" aria-hidden /> {b.keyCount}
                </span>
                {b.website ? (
                  <span className="text-status-warning bg-status-warning/12 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium">
                    <GlobeIcon className="size-3" aria-hidden /> Public
                  </span>
                ) : (
                  <span className="text-muted-foreground inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs">
                    <LockIcon className="size-3" aria-hidden /> Private
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
