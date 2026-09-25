import * as React from 'react';
import { CalmRow, type Tone } from '@/components/calm';
import { relTime } from '@/lib/format';
import type { GitApp } from './gitops-types';
import { envLabel, planStatus, sha7 } from './plan-status';

const TONE: Record<string, Tone> = { online: 'ok', progress: 'info', warning: 'warn', offline: 'bad', neutral: 'idle' };

function status(st: string | undefined): { tone: Tone; word: string } {
  if (!st) return { tone: 'idle', word: 'Waiting' };
  const p = planStatus(st);
  return { tone: TONE[p.tone] ?? 'idle', word: p.label };
}

/**
 * Every place this app runs from git — production, named environments and
 * branch/PR previews — one row each (boards Environments · BranchPreviews).
 */
export function AppEnvironmentsList({ app, stack }: { app: GitApp; stack: string }): React.JSX.Element | null {
  if (app.environments.length + app.previews.length <= 1) return null;
  return (
    <div className="border-border -mx-1 flex flex-col border-t pt-1">
      {app.environments.map((e) => (
        <CalmRow
          key={e.stack}
          tone={status(e.latest?.status).tone}
          word={status(e.latest?.status).word}
          name={envLabel(e.environment)}
          sub={e.stack === stack ? 'this one' : e.stack}
          say={`Tracks ${e.branch}${e.latest ? ` · last deploy ${relTime(e.latest.createdAt)}` : ''}`}
          tech={e.latest ? `${sha7(e.latest.sha)} · ${e.latest.status}` : undefined}
          to={e.stack === stack ? undefined : '/stacks/$name/releases'}
          params={{ name: e.stack }}
        />
      ))}
      {app.previews.map((p) => (
        <CalmRow
          key={p.stack}
          tone={status(p.status).tone}
          word={status(p.status).word}
          name={p.branch ?? `#${p.pr}`}
          sub={p.url ?? p.stack}
          say={`Preview${p.data ? ` with a copy of ${p.data.from}'s data` : ''} · updated ${relTime(p.updatedAt)}`}
          tech={`${sha7(p.sha)} · ${p.status}`}
          to={p.stack === stack ? undefined : '/stacks/$name/releases'}
          params={{ name: p.stack }}
        />
      ))}
    </div>
  );
}
