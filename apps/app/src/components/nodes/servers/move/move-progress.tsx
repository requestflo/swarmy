import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { CheckIcon } from 'lucide-react';
import type { MoveStep } from '@swarmy/core';
import { OLD_COPY_KEEP_DAYS } from '@swarmy/core';
import { Button, cn } from '@swarmy/ui';
import { StatusWord, Tech } from '@/components/calm';
import type { MoveRun } from './move-context';
import { STEP_ORDER, STEP_WORDS, type MovePhase } from './move-rules';

/** The steps so far, the one in flight marked (it's the only thing that moves on screen). */
function Steps({ step }: { step: MoveStep | null }): React.JSX.Element {
  const at = step ? STEP_ORDER.indexOf(step) : -1;
  return (
    <ol className="flex flex-col gap-1.5 text-[13px]">
      {STEP_ORDER.map((s, i) => (
        <li key={s} aria-current={i === at ? 'step' : undefined} className={cn('flex items-center gap-2', i > at && 'text-muted-foreground')}>
          {i < at ? (
            <CheckIcon aria-hidden className="text-tone-ok size-3.5" />
          ) : (
            <span aria-hidden className={cn('mx-[3px] size-2 rounded-full', i === at ? 'bg-status-progress animate-pulse motion-reduce:animate-none' : 'bg-foreground/15')} />
          )}
          {STEP_WORDS[s]}
        </li>
      ))}
    </ol>
  );
}

/**
 * A running move, from the service's `swarmy.move.state` label, then its
 * outcome. No Undo: moving it straight back would meet the old copy on
 * the first server, which the mover never overwrites.
 */
export function MoveProgress({ run, phase, step, from, to, onDismiss }: { run: MoveRun; phase: MovePhase; step: MoveStep | null; from: string; to: string; onDismiss: () => void }): React.JSX.Element {
  const s = run.chip.short;
  const done = phase === 'done' || phase === 'rolled-back' || phase === 'not-started';
  const head =
    phase === 'done'
      ? { tone: 'ok' as const, word: 'Moved', title: `${s} now runs on ${to}.`, body: `The old copy stays on ${from} for ${OLD_COPY_KEEP_DAYS} days; ${from}’s page asks about it then.` }
      : phase === 'rolled-back'
        ? { tone: 'warn' as const, word: 'Put back', title: `${s} is back on ${from}.`, body: 'Something went wrong mid-move, so swarmy put it back where its data is. Any copy it had started is removed.' }
        : phase === 'not-started'
          ? { tone: 'bad' as const, word: 'Didn’t start', title: `The move of ${s} didn’t start.`, body: 'swarmy refused it before copying anything, so nothing changed.' }
          : { tone: 'info' as const, word: 'Moving', title: `Moving ${s} to ${to}`, body: `It keeps running on ${from} until the last, short pause.` };
  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      <StatusWord tone={head.tone} word={head.word} pulse={!done} />
      <h3 className="font-display text-[18px] leading-tight font-bold tracking-[-0.01em]">{head.title}</h3>
      <p className="text-muted-foreground text-[13px] leading-relaxed">{head.body}</p>
      {done ? null : <Steps step={step} />}
      <Tech>
        {step ? `swarmy.move.state step=${step}` : phase === 'starting' ? 'waiting for the swarmy.move.state label' : 'swarmy.move.state cleared'}
        {` · ${run.chip.name} → ${run.toId}`}
      </Tech>
      {done ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={onDismiss} className="pointer-coarse:min-h-11">
            Done
          </Button>
          {phase === 'rolled-back' ? (
            <Button asChild size="sm" variant="ghost" className="pointer-coarse:min-h-11">
              <Link to="/audit">See what happened</Link>
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
