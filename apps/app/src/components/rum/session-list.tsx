import * as React from 'react';
import { cn } from '@swarmy/ui';
import { SessionRow } from './session-row';
import type { ReplaySession } from './rum-shared';

interface SessionListProps {
  stack: string;
  sessions: ReplaySession[];
  activeId?: string;
  withErrors: boolean;
  onWithErrors: (v: boolean) => void;
}

/** Recorded sessions, newest first — flat rows in one card, coral rail on the open one. */
export function SessionList({ stack, sessions, activeId, withErrors, onWithErrors }: SessionListProps): React.JSX.Element {
  return (
    <aside className="calm-card shadow-none flex min-h-0 flex-col overflow-hidden" aria-label="Sessions">
      <div className="flex items-center gap-2 px-3 py-3">
        <span className="mono-label text-muted-foreground">Sessions</span>
        <button
          type="button"
          aria-pressed={withErrors}
          onClick={() => onWithErrors(!withErrors)}
          className={cn(
            'ml-auto rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors',
            withErrors ? 'bg-status-offline/12 text-tone-bad' : 'bg-muted text-muted-foreground hover:text-foreground',
          )}
        >
          with errors
        </button>
      </div>
      {sessions.length === 0 ? (
        <p className="text-muted-foreground px-3 pb-4 text-sm">
          {withErrors ? 'No sessions with errors. Nice.' : 'No sessions recorded yet — they show up a few seconds after a visit.'}
        </p>
      ) : (
        <ul className="divide-border max-h-[720px] divide-y overflow-y-auto border-t">
          {sessions.map((s) => (
            <SessionRow key={s.sessionId} stack={stack} session={s} active={s.sessionId === activeId} />
          ))}
        </ul>
      )}
    </aside>
  );
}
