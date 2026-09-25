import * as React from 'react';
import { cn } from '@swarmy/ui';
import { compact, type Breakdown } from './rum-shared';

interface BreakdownListProps {
  title: string;
  rows: Breakdown[];
  /** How an empty key reads ("Direct", "Unknown"). */
  emptyKey?: string;
  /** Monospace keys (paths) vs prose keys (referrers). */
  mono?: boolean;
  /** Small caption right of the title. */
  caption?: string;
  /** Show the visitors column next to views (identified mode). */
  showVisitors?: boolean;
  limit?: number;
  /** Pretty-print a key (country codes → names). */
  format?: (key: string) => string;
  className?: string;
}

/**
 * A ranked list with a soft bar behind each row — top pages, referrers,
 * countries, devices. Bars scale to the top row's views; the number is the
 * label, so identity is never colour alone.
 */
export function BreakdownList({
  title,
  rows,
  emptyKey = '—',
  mono = false,
  caption,
  showVisitors = false,
  limit = 8,
  format,
  className,
}: BreakdownListProps): React.JSX.Element {
  const shown = rows.slice(0, limit);
  const max = Math.max(1, ...shown.map((r) => r.pageviews));
  return (
    <section className={cn('calm-card shadow-none flex min-w-0 flex-col gap-1 p-5', className)} aria-label={title}>
      <div className="flex items-baseline gap-2 pb-1">
        <h2 className="text-base font-bold">{title}</h2>
        {caption ? <span className="text-muted-foreground text-xs">{caption}</span> : null}
        <span className="text-muted-foreground ml-auto font-mono text-[11px]">
          {showVisitors ? 'visitors · views' : 'views'}
        </span>
      </div>
      {shown.length === 0 ? (
        <p className="text-muted-foreground py-4 text-sm">Nothing counted yet.</p>
      ) : (
        <ul className="flex flex-col">
          {shown.map((r) => (
            <li key={r.key || emptyKey} className="relative flex h-8 items-center gap-2 text-sm">
              <i
                aria-hidden
                className="bg-status-progress/12 absolute inset-y-1 left-0 rounded-md"
                style={{ width: `${(r.pageviews / max) * 100}%` }}
              />
              <span className={cn('relative min-w-0 flex-1 truncate pl-2', mono && 'font-mono text-[13px]')}>
                {r.key ? (format ? format(r.key) : r.key) : emptyKey}
              </span>
              {showVisitors ? (
                <span className="text-muted-foreground relative w-14 text-right font-mono text-xs">
                  {compact(r.visitors)}
                </span>
              ) : null}
              <span className="relative w-14 pr-2 text-right font-mono text-[13px]">
                {compact(r.pageviews)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
