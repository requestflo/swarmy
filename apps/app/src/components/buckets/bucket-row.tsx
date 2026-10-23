import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ChevronRightIcon, GlobeIcon, KeyIcon } from 'lucide-react';
import type { BucketSummaryView } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { TONE_DOT, TONE_TEXT } from '@/components/calm';
import { fmtBytes, fmtCount } from './format';
import { REACH_LABEL, REACH_TONE, type ReachMode } from './reach-model';

/** One flat bucket row; it opens the bucket's own page. */
export function BucketRow({ bucket: b, reach }: { bucket: BucketSummaryView; reach: ReachMode | undefined }): React.JSX.Element {
  return (
    <Link
      to="/data/buckets/$name"
      params={{ name: b.name }}
      className="group hover:bg-foreground/[0.025] grid w-full grid-cols-[1fr_auto] items-center gap-4 px-5 py-3.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 sm:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))_auto]"
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
          <span className="text-tone-warn inline-flex items-center gap-1 text-xs font-medium" title="Serves files as a public website">
            <GlobeIcon className="size-3" aria-hidden /> Website
          </span>
        ) : null}
        {reach ? (
          <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium', reach === 'INTERNAL' ? 'text-muted-foreground' : TONE_TEXT[REACH_TONE[reach]])}>
            <span aria-hidden className={cn('size-1.5 rounded-full', TONE_DOT[REACH_TONE[reach]])} />
            {REACH_LABEL[reach]}
          </span>
        ) : (
          <span className="shimmer-line h-3 w-14 rounded" aria-hidden />
        )}
        <ChevronRightIcon aria-hidden className="text-muted-foreground size-4 shrink-0 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
      </span>
    </Link>
  );
}
