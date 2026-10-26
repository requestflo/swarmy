import * as React from 'react';
import type { DbSwitchoverRunView } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { TONE_DOT, TONE_TEXT, Tech } from '@/components/calm';
import { STEP_TONE, STEP_WORD, runWords } from './pg-switchover-words';

/**
 * A planned switchover's progress card (Postgres page and the Data page):
 * the sentence, then each step — pause, catch up, promote, repoint, rejoin —
 * with what it did. Live while it runs (`db.switchoverRun`, every 1.5 s).
 */
export function PgSwitchoverProgress({
  run,
  copyName,
  className,
}: {
  run: DbSwitchoverRunView;
  copyName: (service: string) => string;
  className?: string;
}): React.JSX.Element {
  const w = runWords(run, copyName);
  return (
    <div role="status" aria-live="polite" className={cn('flex flex-col gap-2.5 rounded-xl border px-3.5 py-3', className)}>
      <p className="text-[13.5px] leading-relaxed">
        <b className={cn('font-semibold', TONE_TEXT[w.tone])}>{w.lead}</b> <span className="text-muted-foreground">{w.rest}</span>
      </p>
      <ol className="flex flex-col gap-1.5" aria-label="Switch-over steps">
        {run.steps.map((s) => (
          <li key={s.phase} className="flex min-w-0 items-start gap-2.5">
            <span
              aria-hidden
              className={cn('mt-1.5 size-2 shrink-0 rounded-full', TONE_DOT[STEP_TONE[s.status]], s.status === 'running' && 'motion-safe:animate-pulse')}
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-[13px]">
                {s.label}{' '}
                <span className={cn('font-mono text-[11px]', TONE_TEXT[STEP_TONE[s.status]])}>{STEP_WORD[s.status]}</span>
              </span>
              {s.message && s.status !== 'pending' ? <span className="text-muted-foreground text-[12px]">{s.message}</span> : null}
            </span>
          </li>
        ))}
      </ol>
      <Tech>
        db.switchover {run.runId} · {run.from} → {run.target}
        {run.pausedSeconds !== null ? ` · writes paused ${run.pausedSeconds} s` : ''}
      </Tech>
    </div>
  );
}
