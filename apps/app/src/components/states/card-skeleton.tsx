import * as React from 'react';
import { cn } from '@swarmy/ui';

interface CardSkeletonProps {
  /** Body shimmer rows under the title row. */
  lines?: number;
  className?: string;
}

/** One `calm-card` surface, shimmering — the placeholder for any card still loading. */
export function CardSkeleton({ lines = 2, className }: CardSkeletonProps): React.JSX.Element {
  return (
    <div className={cn('calm-card p-5', className)} aria-hidden>
      <div className="flex items-center justify-between">
        <div className="shimmer-line h-4 w-28 rounded" />
        <div className="shimmer-line size-4 rounded-full" />
      </div>
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          className={cn('shimmer-line mt-3 rounded', i === 0 ? 'h-8 w-1/3' : 'h-4 w-2/3')}
        />
      ))}
    </div>
  );
}

/** Inline shimmer for a single number or word (a footer count, a name). */
export function TextSkeleton({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      className={cn('shimmer-line inline-block h-3.5 w-12 rounded align-middle', className)}
      aria-hidden
    />
  );
}
