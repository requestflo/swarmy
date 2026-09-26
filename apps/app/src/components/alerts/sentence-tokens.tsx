import * as React from 'react';
import { ALERT_SIGNALS, ALERT_SIGNAL_INFO, type AlertSignal, type NotificationChannelView } from '@swarmy/core';
import { Popover, PopoverContent, PopoverTrigger, cn } from '@swarmy/ui';
import { routeWords } from './rule-sentence';
import { formatDuration, formatValue, phraseFor } from './signal-phrases';
import type { RuleDraft } from './use-rule-draft';

interface SentenceTokensProps {
  draft: RuleDraft;
  base: RuleDraft;
  channels: NotificationChannelView[];
  /** Only a new rule can pick its signal (updateRule can't change it). */
  canPickSignal: boolean;
  onPickSignal: (s: AlertSignal) => void;
  /** Ids of the controls each token hands focus to. */
  ids: { value: string; duration: string; channels: string };
}

const tokenCls = (changed: boolean): string =>
  cn(
    'bg-surface-2 dark:bg-accent inline-flex items-center rounded-md px-2 py-0.5 font-mono text-[13.5px] font-semibold outline-none',
    'hover:ring-foreground/20 hover:ring-1 focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:min-h-11',
    changed ? 'text-tone-info' : 'text-foreground',
  );

function Token({ changed, target, children }: { changed: boolean; target: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <button type="button" className={tokenCls(changed)} onClick={() => document.getElementById(target)?.focus()}>
      {children}
    </button>
  );
}

/** "When [error rate] of any app is above [5%] for [5 min] → [#ops Slack]" — each bracket a token. */
export function SentenceTokens({ draft, base, channels, canPickSignal, onPickSignal, ids }: SentenceTokensProps): React.JSX.Element {
  const p = phraseFor(draft.signal);
  const [open, setOpen] = React.useState(false);
  const metric = canPickSignal ? (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className={tokenCls(false)} aria-label="Change what this rule watches">
        {p.metric}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1.5">
        <ul className="flex max-h-80 flex-col overflow-y-auto">
          {ALERT_SIGNALS.map((s) => (
            <li key={s}>
              <button
                type="button"
                onClick={() => {
                  onPickSignal(s);
                  setOpen(false);
                }}
                className={cn('hover:bg-accent w-full rounded-md px-2.5 py-1.5 text-left text-sm pointer-coarse:min-h-11', s === draft.signal && 'bg-accent font-semibold')}
              >
                {ALERT_SIGNAL_INFO[s].label}
                <span className="text-muted-foreground block text-xs">{phraseFor(s).metric}</span>
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  ) : (
    <span className={cn(tokenCls(false), 'hover:ring-0')}>{p.metric}</span>
  );

  return (
    <p className="font-display text-[19px] leading-[2.1] font-semibold tracking-[-0.01em]">
      When {metric}
      {p.op !== null ? (
        <>
          {' '}
          {p.scope} is {p.op}{' '}
          <Token changed={draft.threshold !== base.threshold} target={ids.value}>
            {formatValue(draft.signal, draft.threshold)}
          </Token>
        </>
      ) : null}
      {p.held ? (
        <>
          {' '}for{' '}
          <Token changed={draft.forSeconds !== base.forSeconds} target={ids.duration}>
            {formatDuration(draft.forSeconds)}
          </Token>
        </>
      ) : null}{' '}
      →{' '}
      <Token changed={draft.channelIds.join() !== base.channelIds.join()} target={ids.channels}>
        {routeWords(draft.channelIds, channels)}
      </Token>
    </p>
  );
}
