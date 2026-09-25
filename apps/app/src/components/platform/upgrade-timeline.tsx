import * as React from 'react';
import { CheckIcon, Loader2Icon, PauseIcon, XIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import { StatusWord } from '@/components/calm';
import { STEP_TEXT } from './use-platform';

interface StepView {
  key: string;
  status: string;
  detail: string | null;
  error: string | null;
}

/**
 * The live step timeline — one lane per step, in order, each with what it
 * does and what happens if it fails (design board: Upgrade.html).
 */
export function UpgradeTimeline({
  steps,
  pauses,
}: {
  steps: StepView[];
  /** Show the "major · brief pause" marker on the engines lane. */
  pauses?: boolean;
}): React.JSX.Element {
  return (
    <ol className="grid gap-2" aria-label="Upgrade steps">
      {steps.map((s, i) => {
        const t = STEP_TEXT[s.key] ?? { name: s.key, what: '', ifFails: '' };
        const done = s.status === 'done' || s.status === 'skipped';
        const live = s.status === 'running' || s.status === 'waiting';
        const bad = s.status === 'failed' || s.status === 'rolled-back';
        return (
          <li
            key={s.key}
            className={cn(
              'flex items-start gap-3 rounded-xl border p-3',
              live && 'border-primary/60 ring-primary/15 ring-4',
              bad && 'border-destructive/50',
              done && 'bg-transparent',
            )}
          >
            <span
              className={cn(
                'mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full text-xs',
                done && 'bg-status-online/10 text-tone-ok',
                live && 'bg-primary/10 text-foreground',
                bad && 'bg-destructive/15 text-destructive',
                !done && !live && !bad && 'bg-muted text-muted-foreground',
              )}
              aria-hidden
            >
              {done ? (
                <CheckIcon className="size-3.5" />
              ) : s.status === 'waiting' ? (
                <PauseIcon className="size-3.5" />
              ) : live ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : bad ? (
                <XIcon className="size-3.5" />
              ) : (
                <span className="mono-data">{i + 1}</span>
              )}
            </span>
            <span className="grid min-w-0 flex-1 gap-0.5">
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">{t.name}</span>
                {pauses && s.key === 'engines' ? <StatusWord tone="warn" word="major · brief pause" /> : null}
              </span>
              <span className="text-muted-foreground text-xs">{s.error ?? s.detail ?? t.what}</span>
            </span>
            <span className="grid shrink-0 justify-items-end gap-0.5">
              <StatusWord tone={done ? 'ok' : live ? 'info' : bad ? 'bad' : 'idle'} word={s.status === 'waiting' ? 'waiting' : s.status} />
              <span className="text-muted-foreground mono-data hidden text-[10.5px] sm:block">
                {done ? '' : `if it fails: ${t.ifFails}`}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
