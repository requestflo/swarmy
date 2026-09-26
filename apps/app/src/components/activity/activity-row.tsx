import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { cn } from '@swarmy/ui';
import { TONE_DOT, Tech } from '@/components/calm';
import type { ActivityItem, StreamFilter } from './activity-items';
import { StreamPill } from './stream-pill';

function clock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** One Stream line: mono clock · a tone dot on the rail · bold title + pill · the muted sentence. */
export function ActivityRow({
  item,
  selected,
  filter,
}: {
  item: ActivityItem;
  selected?: boolean;
  filter: StreamFilter;
}): React.JSX.Element {
  const body = (
    <>
      <span className="text-muted-foreground w-11 shrink-0 pt-[3px] font-mono text-[11.5px] tabular-nums">{clock(item.at)}</span>
      <span aria-hidden className="bg-card border-border relative z-[1] mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full border">
        <span className={cn('size-2 rounded-full', TONE_DOT[item.tone])} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="line-clamp-2 min-w-0 text-[14px] font-semibold break-words">{item.title}</span>
          {item.word ? <StreamPill word={item.word} tone={item.tone} /> : null}
        </span>
        <span className="text-muted-foreground text-[13px] leading-snug break-words">{item.say}</span>
        <Tech>{item.tech}</Tech>
      </span>
    </>
  );
  const cls = cn(
    'flex min-h-14 items-start gap-3 rounded-[10px] px-2 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
    selected ? 'bg-surface-2 dark:bg-accent' : item.to || item.incidentId ? 'hover:bg-foreground/[0.03]' : '',
  );
  if (item.incidentId) {
    return (
      <Link
        to="/activity"
        search={{ incident: item.incidentId, ...(filter === 'all' ? {} : { filter }) }}
        aria-current={selected ? 'true' : undefined}
        className={cls}
      >
        {body}
      </Link>
    );
  }
  if (item.to) {
    return (
      <Link to={item.to} className={cls}>
        {body}
      </Link>
    );
  }
  return <div className={cls}>{body}</div>;
}
