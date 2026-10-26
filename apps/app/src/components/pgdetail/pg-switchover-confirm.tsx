import * as React from 'react';
import type { SwitchoverPlan } from '@swarmy/core';
import { Button, cn } from '@swarmy/ui';
import { TONE_TEXT, Tech } from '@/components/calm';
import { CardSkeleton } from '@/components/states';
import { bytes } from '@/lib/format';
import { restartWords } from './pg-switchover-words';

/**
 * The confirm for a planned switchover (board 39's "Make this copy the
 * writer", board 15's drag): the question, the consequence in plain words,
 * what swarmy does at Controls, and the one coral button. A refusal shows
 * why instead of the button; an unread plan is a skeleton, never a guess.
 */
export function PgSwitchoverConfirm({
  question,
  plan,
  copyName,
  readError,
  starting,
  onConfirm,
  onCancel,
  className,
}: {
  question: string;
  /** The shared plan for this copy; null while its reads are in flight. */
  plan: SwitchoverPlan | null;
  copyName: (service: string) => string;
  readError: string | null;
  starting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  className?: string;
}): React.JSX.Element {
  const ok = plan?.ok === true;
  return (
    <div role="group" aria-label={question} className={cn('bg-muted/50 flex flex-col gap-2 rounded-xl border px-3.5 py-3', className)}>
      <span className="font-display text-[15px] font-bold tracking-[-0.01em]">{question}</span>
      {plan === null ? (
        readError ? (
          <p className="text-tone-warn text-[13px]">Couldn’t ask the main copy how far behind each copy is: {readError}</p>
        ) : (
          <CardSkeleton />
        )
      ) : plan.ok ? (
        <>
          <p className="text-[13px] leading-relaxed">
            Writes pause for a few seconds; nothing is lost. {copyName(plan.from)} then follows it as a standby. {restartWords(plan.restarts)}
          </p>
          <Tech>
            {bytes(plan.behindBytes)} behind now · writes paused (default_transaction_read_only) until {plan.target} replays the final flushed LSN, at most 60 s, else nothing
            switches · the reconcile promotes it through decideFailover and repoints the copies and the pooler · the old main copy re-clones, its data kept aside
            {plan.restarts.length > 0 ? ' · each app wired straight to it gets a DATABASE_URL secret for the new writer and rolls onto it, start-first where it can' : ''}
          </Tech>
        </>
      ) : (
        <p className={cn('text-[13px] leading-relaxed', TONE_TEXT.warn)}>{plan.reason}</p>
      )}
      <div className="flex flex-wrap gap-2 pt-0.5">
        {ok ? (
          <Button size="sm" className="min-h-11 sm:min-h-8" disabled={starting} onClick={onConfirm}>
            {starting ? 'Starting…' : 'Make it the writer'}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" className="min-h-11 sm:min-h-8" onClick={onCancel}>
          {ok ? 'Not now' : 'Close'}
        </Button>
      </div>
    </div>
  );
}
