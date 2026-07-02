import * as React from 'react';
import {
  BellRingIcon,
  CheckCircle2Icon,
  CircleDotIcon,
  DatabaseZapIcon,
  MessageSquareTextIcon,
  RocketIcon,
  RotateCcwIcon,
  ServerCrashIcon,
  SirenIcon,
} from 'lucide-react';
import type { IncidentEventView } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { clockTime } from './incident-status';

interface KindStyle {
  icon: React.ComponentType<{ className?: string }>;
  tone: string; // text-* token class for the icon bubble
}

/** Icon + tone per event kind (prefix-matched, open vocabulary). */
export function kindStyle(kind: string): KindStyle {
  if (kind === 'opened') return { icon: SirenIcon, tone: 'text-status-offline' };
  if (kind === 'resolved' || kind.endsWith('.resolved'))
    return { icon: CheckCircle2Icon, tone: 'text-status-online' };
  if (kind === 'reopened') return { icon: RotateCcwIcon, tone: 'text-status-warning' };
  if (kind === 'note') return { icon: MessageSquareTextIcon, tone: 'text-primary' };
  if (kind.startsWith('alert.')) return { icon: BellRingIcon, tone: 'text-status-warning' };
  if (kind.startsWith('db.')) return { icon: DatabaseZapIcon, tone: 'text-status-progress' };
  if (kind.startsWith('deploy.') || kind.startsWith('release.'))
    return { icon: RocketIcon, tone: 'text-status-progress' };
  if (kind.startsWith('node.')) return { icon: ServerCrashIcon, tone: 'text-status-offline' };
  return { icon: CircleDotIcon, tone: 'text-muted-foreground' };
}

function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

/**
 * The clean vertical timeline: mono clock, an icon per kind on a hairline
 * rail, the message — the "14:01 London node offline → 14:05 resolved" story.
 */
export function IncidentTimeline({ events }: { events: IncidentEventView[] }): React.JSX.Element {
  let lastDay = '';
  return (
    <ol className="relative">
      {events.map((event, i) => {
        const { icon: Icon, tone } = kindStyle(event.kind);
        const day = dayLabel(event.at);
        const showDay = day !== lastDay;
        lastDay = day;
        const author = typeof event.meta.author === 'string' ? event.meta.author : null;
        return (
          <li key={event.id}>
            {showDay ? (
              <p className={cn('mono-label text-muted-foreground px-6 pb-1', i > 0 && 'pt-4')}>
                {day}
              </p>
            ) : null}
            <div className="group flex gap-4 px-6">
              <p className="mono-data text-muted-foreground w-16 shrink-0 pt-1 text-right text-xs tabular-nums">
                {clockTime(event.at)}
              </p>
              <div className="flex flex-col items-center">
                <span
                  className={cn(
                    'bg-card flex size-7 shrink-0 items-center justify-center rounded-full border shadow-sm',
                    tone,
                  )}
                >
                  <Icon className="size-3.5" />
                </span>
                {i < events.length - 1 ? <span className="bg-border w-px flex-1" /> : null}
              </div>
              <div className="min-w-0 flex-1 pb-6">
                <p className="mono-label text-muted-foreground">
                  {event.kind}
                  {author ? ` · ${author}` : ''}
                </p>
                <p className={cn('mt-0.5 text-sm', event.kind === 'note' && 'whitespace-pre-wrap')}>
                  {event.message}
                </p>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
