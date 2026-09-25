import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { cn } from '@swarmy/ui';
import { TONE_DOT, TONE_TEXT, Tech } from '@/components/calm';
import type { ActivityItem } from './activity-items';

function clock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** One timeline line: mono clock · dot · what happened · the plain sentence · status word. */
export function ActivityRow({ item }: { item: ActivityItem }): React.JSX.Element {
  const body = (
    <>
      <span className="text-muted-foreground w-11 shrink-0 pt-0.5 font-mono text-[11.5px]">{clock(item.at)}</span>
      <span aria-hidden className={cn('mt-[7px] size-2 shrink-0 rounded-full', TONE_DOT[item.tone])} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="truncate text-[14px] font-semibold">{item.title}</span>
          {item.word ? <span className={cn('text-xs font-semibold', TONE_TEXT[item.tone])}>{item.word}</span> : null}
        </span>
        <span className="text-muted-foreground text-[13px] leading-snug break-words">{item.say}</span>
        <Tech>{item.tech}</Tech>
      </span>
    </>
  );
  const cls =
    'border-border flex min-h-14 items-start gap-3 border-b px-1 py-2.5 last:border-b-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50';
  if (item.to) {
    return (
      <Link to={item.to} params={item.params as never} className={cn(cls, 'hover:bg-foreground/[0.025]')}>
        {body}
      </Link>
    );
  }
  return <div className={cls}>{body}</div>;
}
