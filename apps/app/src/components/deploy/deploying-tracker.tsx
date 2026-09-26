import * as React from 'react';
import { AlertTriangleIcon, CheckIcon, LoaderCircleIcon, MinusIcon, XIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import { TONE_TEXT, Tech, type Tone } from '@/components/calm';
import type { DeployStep, StepKey, StepState } from './deploy-steps';
import { clock } from './deploy-elapsed';

const TONE: Record<StepState, Tone> = {
  done: 'ok',
  working: 'info',
  waiting: 'idle',
  skipped: 'idle',
  failed: 'bad',
  needs: 'warn',
};

const RING: Record<StepState, string> = {
  done: 'border-status-online/60 bg-status-online/10 text-tone-ok',
  working: 'border-status-progress bg-status-progress/15 text-tone-info',
  waiting: 'border-border text-muted-foreground',
  skipped: 'border-border border-dashed text-muted-foreground',
  failed: 'border-status-offline bg-status-offline/10 text-tone-bad',
  needs: 'border-status-warning bg-status-warning/10 text-tone-warn',
};

export { clock };

/** "0:12" when done (from the deploy's start), "working · 0:07" while it runs. */
function word(s: DeployStep, at: number | undefined, since: number | undefined): string {
  if (s.state === 'done') return at === undefined ? 'done' : clock(at);
  if (s.state === 'needs') return 'needs you';
  if (s.state === 'working' && since !== undefined) return `working · ${clock(Math.max(0, since))}`;
  return s.state;
}

function Dot({ step, n }: { step: DeployStep; n: number }): React.JSX.Element {
  const cls = 'size-4';
  const icon =
    step.state === 'done' ? <CheckIcon className={cls} /> :
    step.state === 'working' ? <LoaderCircleIcon className={cn(cls, 'animate-spin motion-reduce:animate-none')} /> :
    step.state === 'failed' ? <XIcon className={cls} /> :
    step.state === 'needs' ? <AlertTriangleIcon className={cls} /> :
    step.state === 'skipped' ? <MinusIcon className={cls} /> :
    <span className="font-mono text-[12px]">{n}</span>;
  return (
    <span aria-hidden className={cn('bg-card relative z-10 flex size-10 shrink-0 items-center justify-center rounded-full border-2', RING[step.state])}>
      {icon}
    </span>
  );
}

/**
 * The five-step tracker (board "Deploying"): a row across the page on a wide
 * screen, a vertical rail on a phone. Each step: its title, a plain sub-line,
 * the state word (done with its time from the deploy's start, or how long it
 * has been working), and at Controls the mono tech lines.
 */
export function DeployingTracker({
  steps,
  doneAt,
  workingFor = {},
}: {
  steps: DeployStep[];
  doneAt: Partial<Record<StepKey, number>>;
  /** Seconds each working step has been running (streamed deploys only). */
  workingFor?: Partial<Record<StepKey, number>>;
}): React.JSX.Element {
  return (
    <ol aria-label="Deploy steps" className="grid gap-0 lg:grid-cols-5 lg:gap-4">
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        const through = s.state === 'done' || s.state === 'skipped';
        return (
          <li
            key={s.key}
            aria-current={s.state === 'working' ? 'step' : undefined}
            className={cn('relative flex gap-4 pb-6 lg:flex-col lg:items-center lg:pb-0 lg:text-center', s.state === 'skipped' && 'opacity-60')}
          >
            {!last ? (
              <span
                aria-hidden
                className={cn(
                  'absolute left-5 top-10 bottom-0 w-0.5 -translate-x-1/2 lg:left-[calc(50%+1.25rem)] lg:top-5 lg:right-[calc(-50%+1.25rem-1rem)] lg:bottom-auto lg:h-0.5 lg:w-auto lg:translate-x-0',
                  through ? 'bg-status-online/60' : 'bg-border',
                )}
              />
            ) : null}
            <Dot step={s} n={i + 1} />
            <div className="flex min-w-0 flex-col gap-0.5 pt-1.5 lg:items-center lg:pt-2">
              <span className="font-display text-[15px] font-bold tracking-[-0.01em]">{s.title}</span>
              <span className="text-muted-foreground text-[12.5px]">{s.sub}</span>
              <span className={cn('font-mono text-[13px]', TONE_TEXT[TONE[s.state]])}>
                <span className="sr-only">Status: </span>
                {word(s, doneAt[s.key], workingFor[s.key])}
              </span>
              {s.tech ? <Tech className="lg:max-w-[22ch]">{s.tech}</Tech> : null}
              {(s.facts ?? []).map((f) => (
                <Tech key={f} className="lg:max-w-[22ch]">
                  {f}
                </Tech>
              ))}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
