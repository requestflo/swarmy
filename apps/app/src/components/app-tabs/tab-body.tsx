import * as React from 'react';
import { cn } from '@swarmy/ui';

/**
 * The body of one app-workspace tab. The workspace layout (S1) owns the app
 * header and tab strip; a tab brings its own sentence header, a main column
 * of `Section`s and an optional aside (the Code view goes at its top).
 */
export function TabBody({
  header,
  aside,
  children,
  className,
}: {
  header: React.ReactNode;
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn('flex flex-col gap-6 pb-24 lg:pb-12', className)}>
      {header}
      <div className={cn('grid gap-5', aside ? 'xl:grid-cols-[minmax(0,1fr)_400px]' : 'grid-cols-1')}>
        <div className="flex min-w-0 flex-col gap-5">{children}</div>
        {aside ? <aside className="flex min-w-0 flex-col gap-4">{aside}</aside> : null}
      </div>
    </div>
  );
}

/** "1 thing" / "2 things" — the plural every sentence header needs. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Spelled-out small counts read better in a sentence ("Two copies"). */
const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
export function countWord(n: number, lower = false): string {
  const w = WORDS[n] ?? String(n);
  return lower ? w.toLowerCase() : w;
}

/** Shimmering hairline rows — a `Section`'s list while its query is pending. */
export function RowsSkeleton({ rows = 3 }: { rows?: number }): React.JSX.Element {
  return (
    <div aria-hidden className="flex flex-col">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="border-border flex min-h-14 items-center gap-3 border-b last:border-b-0">
          <div className="shimmer-line size-2 rounded-full" />
          <div className="shimmer-line h-3.5 w-32 rounded" />
          <div className="shimmer-line ml-4 hidden h-3 w-64 rounded sm:block" />
        </div>
      ))}
    </div>
  );
}
