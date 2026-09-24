import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { cn } from '@swarmy/ui';
import { Chip } from './rum-ui';
import { clock, hhmm, sessionWho, type ReplaySession } from './rum-shared';

interface SessionRowProps {
  stack: string;
  session: ReplaySession;
  active: boolean;
}

/** One recorded visit: who, how long, where they landed, what went wrong. */
export function SessionRow({ stack, session: s, active }: SessionRowProps): React.JSX.Element {
  return (
    <li>
      <Link
        to="/stacks/$name/replays/$sessionId"
        params={{ name: stack, sessionId: s.sessionId }}
        aria-current={active ? 'true' : undefined}
        className={cn(
          'flex flex-col gap-1 border-l-[3px] px-3 py-2.5 transition-colors',
          active ? 'border-primary bg-accent' : 'hover:bg-accent/60 border-transparent',
        )}
      >
        <span className="flex items-center gap-2">
          <span className="text-muted-foreground font-mono text-[11px] font-bold">{s.country || '—'}</span>
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{sessionWho(s)}</span>
          <span className="text-muted-foreground font-mono text-[11px]">{clock(s.durationMs)}</span>
        </span>
        <span className="text-muted-foreground truncate font-mono text-[11px]">{s.firstPath || '/'}</span>
        <span className="flex flex-wrap items-center gap-1.5">
          <Chip>{s.clicks} clicks</Chip>
          {s.errors > 0 ? <Chip tone="offline">{s.errors === 1 ? '1 error' : `${s.errors} errors`}</Chip> : null}
          <span className="text-muted-foreground ml-auto font-mono text-[10.5px]">{hhmm(s.startedAt)}</span>
        </span>
      </Link>
    </li>
  );
}
