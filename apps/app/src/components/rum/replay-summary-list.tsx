import * as React from 'react';
import { CalmRow, RowList, Section } from '@/components/calm';
import { clock, hhmm, sessionWho, type ReplaySession } from './rum-shared';

/** Summary depth: the week's recorded visits as plain rows, newest first. */
export function ReplaySummaryList({ stack, sessions }: { stack: string; sessions: ReplaySession[] }): React.JSX.Element | null {
  if (sessions.length === 0) return null;
  return (
    <Section title="Recorded visits" count={sessions.length} flush>
      <RowList label="Recorded visits">
        {sessions.slice(0, 10).map((s) => (
          <CalmRow
            key={s.sessionId}
            tone={s.errors > 0 ? 'warn' : 'ok'}
            name={sessionWho(s)}
            sub={`${s.country || '—'} · ${hhmm(s.startedAt)}`}
            say={`${clock(s.durationMs)} from ${s.firstPath || '/'}, ${s.clicks} clicks${s.errors ? `, ${s.errors === 1 ? '1 error' : `${s.errors} errors`}` : ''}.`}
            word="Watch →"
            wordTone="info"
            to={`/stacks/${stack}/replays/${s.sessionId}`}
          />
        ))}
      </RowList>
    </Section>
  );
}
