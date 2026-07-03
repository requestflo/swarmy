import * as React from 'react';
import { ChevronDownIcon, GlobeIcon, KeyIcon, LockIcon } from 'lucide-react';
import type { BucketSummaryView } from '@swarmy/core';
import { Collapsible, CollapsibleContent, cn } from '@swarmy/ui';
import { BucketDetailPanel } from './bucket-detail-panel';
import { fmtBytes, fmtCount } from './format';

interface BucketRowProps {
  bucket: BucketSummaryView;
  expanded: boolean;
  onToggle: () => void;
  onDeleted: () => void;
}

/** One flat bucket row; clicking expands the full detail inline underneath. */
export function BucketRow({ bucket: b, expanded, onToggle, onDeleted }: BucketRowProps): React.JSX.Element {
  return (
    <div className={cn(expanded && 'bg-accent/40 shadow-[inset_3px_0_0_var(--primary)]')}>
      <button
        type="button"
        onClick={onToggle}
        className="hover:bg-accent/50 grid w-full grid-cols-[1fr_auto] items-center gap-4 px-5 py-3.5 text-left transition-colors sm:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))_auto]"
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
          <ChevronDownIcon
            className={cn(
              'text-muted-foreground size-4 shrink-0 transition-transform',
              expanded && 'rotate-180',
            )}
          />
        </span>
      </button>
      <Collapsible open={expanded}>
        <CollapsibleContent>
          <BucketDetailPanel bucketId={b.id} onDeleted={onDeleted} />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
