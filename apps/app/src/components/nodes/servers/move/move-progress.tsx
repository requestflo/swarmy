import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { CheckIcon } from 'lucide-react';
import type { MoveStep } from '@swarmy/core';
import { Button, cn } from '@swarmy/ui';
import { StatusWord, Tech } from '@/components/calm';
import type { MoveRun } from './move-context';
import { outcomeWords, UNDO_STEP_ORDER, UNDO_STEP_WORDS } from './move-outcome';
import { STEP_ORDER, STEP_WORDS, type MovePhase } from './move-rules';
import { MoveUndo } from './move-undo';

/** The steps so far, the one in flight marked (it's the only thing that moves on screen). */
function Steps({ step, undo }: { step: MoveStep | null; undo: boolean }): React.JSX.Element {
  const order = undo ? UNDO_STEP_ORDER : STEP_ORDER;
  const at = step ? order.indexOf(step) : -1;
  return (
    <ol className="flex flex-col gap-1.5 text-[13px]">
      {order.map((s, i) => (
        <li key={s} aria-current={i === at ? 'step' : undefined} className={cn('flex items-center gap-2', i > at && 'text-muted-foreground')}>
          {i < at ? (
            <CheckIcon aria-hidden className="text-tone-ok size-3.5" />
          ) : (
            <span aria-hidden className={cn('mx-[3px] size-2 rounded-full', i === at ? 'bg-status-progress animate-pulse motion-reduce:animate-none' : 'bg-foreground/15')} />
          )}
          {(undo ? UNDO_STEP_WORDS[s] : undefined) ?? STEP_WORDS[s]}
        </li>
      ))}
    </ol>
  );
}

/**
 * A running move (or its Undo), from the service's `swarmy.move.state`
 * label, then its outcome. A finished move offers Undo: back onto the old
 * copy it kept, which `decommission.undoMove` allows only while both copies
 * still match the move's snapshot point.
 */
export function MoveProgress({ run, phase, step, from, to, onDismiss }: { run: MoveRun; phase: MovePhase; step: MoveStep | null; from: string; to: string; onDismiss: () => void }): React.JSX.Element {
  const undo = run.undo === true;
  const done = phase === 'done' || phase === 'rolled-back' || phase === 'not-started';
  const head = outcomeWords({ phase, short: run.chip.short, from, to, undo });
  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      <StatusWord tone={head.tone} word={head.word} pulse={!done} />
      <h3 className="font-display text-[18px] leading-tight font-bold tracking-[-0.01em]">{head.title}</h3>
      <p className="text-muted-foreground text-[13px] leading-relaxed">{head.body}</p>
      {done ? null : <Steps step={step} undo={undo} />}
      {phase === 'done' && !undo ? <MoveUndo key={run.startedAt} run={run} from={from} /> : null}
      <Tech>
        {step ? `swarmy.move.state step=${step}${undo ? ' undo' : ''}` : phase === 'starting' ? 'waiting for the swarmy.move.state label' : 'swarmy.move.state cleared'}
        {` · ${run.chip.name} → ${run.toId}`}
        {undo ? ' · decommission.undoMove: no copy, back onto the old one' : ''}
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
