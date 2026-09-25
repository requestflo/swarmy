import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { cn } from '@swarmy/ui';
import { TONE_DOT, Tech } from '@/components/calm';
import { relTime } from '@/lib/format';
import type { TodayItem } from './today-items';

function clock(at: string): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** "Today": the day's changes and backups as quiet timed lines, each linking to where it lives. */
export function TodayFeed({ items, today }: { items: TodayItem[]; today: boolean }): React.JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="today-h" className="flex flex-col gap-1 px-1">
      <h2 id="today-h" className="calm-eyebrow pb-1">
        {today ? 'Today' : 'Recently'}
      </h2>
      <ul className="flex flex-col">
        {items.map((it) => (
          <li key={it.id}>
            <Link
              to={it.to}
              params={it.params as never}
              className="hover:bg-foreground/[0.025] flex min-h-9 items-start gap-3 rounded-sm px-1 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:min-h-11"
            >
              <span className="text-muted-foreground w-12 shrink-0 pt-px font-mono text-[11.5px]">
                {today ? clock(it.at) : relTime(it.at)}
              </span>
              <span aria-hidden className={cn('mt-[7px] size-2 shrink-0 rounded-full', TONE_DOT[it.tone])} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[13.5px]">{it.say}</span>
                <Tech className="truncate">{it.tech}</Tech>
              </span>
              <span className="text-primary shrink-0 font-mono text-[11.5px]">See</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
