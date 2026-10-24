import * as React from 'react';
import { CopyButton } from '@swarmy/ui';
import { GitChip } from './git-chip';
import type { MigrationStep } from './git-scan-types';

function Step({ no, step }: { no: number; step: MigrationStep }): React.JSX.Element {
  const code = step.lines.join('\n');
  return (
    <li className="flex gap-3">
      <span aria-hidden className="text-muted-foreground w-5 shrink-0 text-right font-mono text-[12px] leading-8">
        {no}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="flex min-h-8 flex-wrap items-center gap-2">
          <b className="text-[13.5px] font-semibold">{step.title}</b>
          <GitChip tone={step.where === 'terminal' ? 'idle' : 'info'}>{step.where === 'terminal' ? 'your terminal' : 'swarmy'}</GitChip>
          {step.where === 'terminal' ? <CopyButton value={code} label="Copy" className="ml-auto" /> : null}
        </span>
        {step.where === 'terminal' ? (
          <pre tabIndex={0} aria-label={`${step.title}, commands`} className="calm-code min-w-0 overflow-x-auto px-3 py-2.5 text-[12px] whitespace-pre">
            {code}
          </pre>
        ) : (
          <span className="font-mono text-[12.5px]">{code}</span>
        )}
        {step.note ? <span className="text-muted-foreground text-[12.5px] leading-snug">{step.note}</span> : null}
      </div>
    </li>
  );
}

/**
 * Bring the data and config across (the Heroku import, board 24). swarmy
 * doesn't move them: the data goes Heroku backup → the database's own
 * backups → Restore in place, the config `heroku config` → Paste .env.
 * Every command is the real one, worked out for this app.
 */
export function GitHerokuSteps({ data, config }: { data: MigrationStep[]; config: MigrationStep[] }): React.JSX.Element {
  return (
    <section aria-label="Bring the data and config across" className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-col gap-1">
        <span className="calm-eyebrow">Bring the data and config across</span>
        <p className="text-muted-foreground text-[13px] leading-relaxed">
          swarmy doesn’t touch Heroku. After the first deploy, these move {data.length ? 'the data and ' : ''}the settings over — Heroku keeps
          serving until you switch.
        </p>
      </div>
      {data.length ? (
        <div className="flex flex-col gap-2">
          <span className="calm-eyebrow">Data</span>
          <ol className="flex flex-col gap-3">
            {data.map((s, i) => (
              <Step key={`${i}:${s.title}`} no={i + 1} step={s} />
            ))}
          </ol>
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        <span className="calm-eyebrow">Config vars</span>
        <ol className="flex flex-col gap-3">
          {config.map((s, i) => (
            <Step key={s.title} no={data.length + i + 1} step={s} />
          ))}
        </ol>
      </div>
    </section>
  );
}
