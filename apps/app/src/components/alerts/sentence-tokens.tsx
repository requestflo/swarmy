import * as React from 'react';
import {
  ALERT_SIGNALS,
  ALERT_SIGNAL_INFO,
  selectorKey,
  signalTargetKind,
  type AlertSelector,
  type AlertSignal,
  type NotificationChannelView,
} from '@swarmy/core';
import { Popover, PopoverContent, PopoverTrigger, cn } from '@swarmy/ui';
import { routeWords, targetWords } from './rule-sentence';
import { formatDuration, formatValue, phraseFor } from './signal-phrases';
import type { AlertTargetOptions } from './use-alert-targets';
import type { RuleDraft } from './use-rule-draft';

interface SentenceTokensProps {
  draft: RuleDraft;
  base: RuleDraft;
  channels: NotificationChannelView[];
  /** Only a new rule can pick its signal (updateRule can't change it). */
  canPickSignal: boolean;
  onPickSignal: (s: AlertSignal) => void;
  /** Apps (with parts) and servers the target token offers. */
  targets: AlertTargetOptions;
  onPickTarget: (sel: AlertSelector) => void;
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

const pickCls = (on: boolean, indent = false): string =>
  cn('hover:bg-accent w-full rounded-md px-2.5 py-1.5 text-left text-sm pointer-coarse:min-h-11', indent && 'pl-6 font-mono text-[13px]', on && 'bg-accent font-semibold');

/**
 * The target token: "[any app ▾]" → any app · storefront · storefront /
 * checkout, or "[any server ▾]" → any server · london-2. Signals with no
 * target kind render nothing (they only take "any").
 */
function TargetToken({
  signal,
  selector,
  changed,
  targets,
  onPick,
}: {
  signal: string;
  selector: AlertSelector;
  changed: boolean;
  targets: AlertTargetOptions;
  onPick: (sel: AlertSelector) => void;
}): React.JSX.Element | null {
  const [open, setOpen] = React.useState(false);
  const kind = signalTargetKind(signal);
  const words = targetWords(signal, selector);
  if (!kind || !words) return null;
  const current = selectorKey(selector);
  const pick = (sel: AlertSelector): void => {
    onPick(sel);
    setOpen(false);
  };
  const item = (sel: AlertSelector, label: string, indent = false): React.JSX.Element => (
    <li key={selectorKey(sel)}>
      <button type="button" aria-pressed={selectorKey(sel) === current} className={pickCls(selectorKey(sel) === current, indent)} onClick={() => pick(sel)}>
        {label}
      </button>
    </li>
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className={tokenCls(changed)} aria-label={`What this rule watches: ${words}. Change it`}>
        {words} <span aria-hidden className="text-muted-foreground ml-1 text-[11px]">▾</span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1.5">
        <ul className="flex max-h-80 flex-col overflow-y-auto">
          {kind === 'server' ? (
            <>
              {item({}, 'Any server')}
              {targets.servers.map((server) => item({ server }, server))}
              {selector.server && !targets.servers.includes(selector.server) ? item(selector, selector.server) : null}
            </>
          ) : (
            <>
              {item({}, 'Any app')}
              {targets.apps.map((app) => (
                <React.Fragment key={app.name}>
                  {item({ app: app.name }, app.name)}
                  {app.parts.map((service) => item({ app: app.name, service }, `/ ${service}`, true))}
                </React.Fragment>
              ))}
              {selector.app && !targets.apps.some((a) => a.name === selector.app) ? item(selector, words) : null}
            </>
          )}
        </ul>
        <p className="text-muted-foreground px-2.5 pt-1.5 pb-1 text-xs">
          {kind === 'server' ? 'One server, or every server.' : 'One app, one part of it, or every app.'} Another rule can watch the rest.
        </p>
      </PopoverContent>
    </Popover>
  );
}

/** "When [error rate] of [storefront / checkout ▾] is above [5%] for [5 min] → [#ops Slack]" — each bracket a token. */
export function SentenceTokens({ draft, base, channels, canPickSignal, onPickSignal, targets, onPickTarget, ids }: SentenceTokensProps): React.JSX.Element {
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

  const target = p.prep ? (
    <>
      {' '}
      {p.prep}{' '}
      <TargetToken
        signal={draft.signal}
        selector={draft.selector}
        changed={selectorKey(draft.selector) !== selectorKey(base.selector)}
        targets={targets}
        onPick={onPickTarget}
      />
    </>
  ) : null;

  return (
    <p className="font-display text-[19px] leading-[2.1] font-semibold tracking-[-0.01em]">
      When {metric}
      {target}
      {p.op !== null ? (
        <>
          {' '}is {p.op}{' '}
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
