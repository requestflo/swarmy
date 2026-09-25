import * as React from 'react';
import { cn } from '@swarmy/ui';
import { CardSkeleton } from './card-skeleton';

export type PageSkeletonVariant = 'list' | 'kpis' | 'canvas' | 'form';

interface PageSkeletonProps {
  variant?: PageSkeletonVariant;
  /** Draw the eyebrow + headline shimmer above the body (default true). */
  header?: boolean;
  className?: string;
}

/** Eyebrow + headline shimmer — the page frame, drawn before any number exists. */
export function HeaderSkeleton({ className }: { className?: string }): React.JSX.Element {
  return (
    <div className={cn('mb-8', className)} aria-hidden>
      <div className="shimmer-line h-6 w-24 rounded-full" />
      <div className="shimmer-line mt-4 h-10 w-2/3 max-w-md rounded-lg sm:h-12" />
      <div className="shimmer-line mt-3 h-4 w-1/2 max-w-sm rounded" />
    </div>
  );
}

/**
 * Unknown is a skeleton; zero is a fact. Every route renders one of these while
 * its first query is pending so the page frame paints immediately and no
 * placeholder number ever reaches the screen.
 */
export function PageSkeleton({
  variant = 'list',
  header = true,
  className,
}: PageSkeletonProps): React.JSX.Element {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading"
      className={cn('mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10', className)}
    >
      {header ? <HeaderSkeleton /> : null}
      <SkeletonBody variant={variant} />
    </div>
  );
}

/** Just the body of a skeleton — for surfaces that already drew their header. */
export function SkeletonBody({ variant }: { variant: PageSkeletonVariant }): React.JSX.Element {
  switch (variant) {
    case 'kpis':
      return (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <CardSkeleton key={i} lines={1} className="h-[7.25rem]" />
            ))}
          </div>
          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <CardSkeleton key={i} lines={2} />
            ))}
          </div>
        </>
      );
    case 'canvas':
      return <div className="shimmer-line h-[clamp(420px,60vh,760px)] w-full rounded-3xl" />;
    case 'form':
      return (
        <div className="space-y-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="space-y-2">
              <div className="shimmer-line h-3.5 w-28 rounded" />
              <div className="shimmer-line h-10 w-full rounded-lg" />
            </div>
          ))}
        </div>
      );
    default:
      return (
        <div className="calm-card divide-border divide-y overflow-hidden">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex h-14 items-center gap-4 px-5">
              <div className="shimmer-line size-2 rounded-full" />
              <div className="shimmer-line h-4 w-1/3 rounded" />
              <div className="shimmer-line ml-auto h-4 w-16 rounded" />
            </div>
          ))}
        </div>
      );
  }
}
