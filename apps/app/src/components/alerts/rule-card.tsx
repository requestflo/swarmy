import * as React from 'react';
import type { AlertEventView, AlertRuleView, NotificationChannelView } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { TONE_DOT, TONE_TEXT, Tech, type Tone } from '@/components/calm';
import { relTime } from '@/lib/format';
import { rawExpression } from './rule-facts';
import { resourceName, ruleSentence } from './rule-sentence';

interface RuleCardProps {
  rule: AlertRuleView;
  channels: NotificationChannelView[];
  firing: AlertEventView[];
  lastFired: AlertEventView | undefined;
  /** Set when another rule for the same signal is the one swarmy uses. */
  shadowedBy: AlertRuleView | undefined;
  selected: boolean;
  onSelect: () => void;
}

/** One rule as a quiet card: name, a firing/quiet word, the sentence, and a mono line of what it last saw. */
export function RuleCard({ rule, channels, firing, lastFired, shadowedBy, selected, onSelect }: RuleCardProps): React.JSX.Element {
  const critical = firing.some((e) => e.severity === 'critical');
  const [tone, word]: [Tone, string] = firing.length
    ? [critical ? 'bad' : 'warn', 'firing']
    : !rule.enabled
      ? ['idle', 'off']
      : shadowedBy
        ? ['idle', 'not used']
        : ['ok', 'quiet'];
  const first = firing[0];
  const line = first
    ? `${firing.map((e) => resourceName(e.resource)).join(', ')} · since ${relTime(first.firedAt)}`
    : shadowedBy
      ? `${shadowedBy.name} watches this instead`
      : lastFired
        ? `last fired ${relTime(lastFired.firedAt)} · ${resourceName(lastFired.resource)}`
        : 'hasn’t fired lately';
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'calm-card flex w-full flex-col gap-1.5 px-4 py-3.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        'hover:bg-foreground/[0.025]',
        selected && 'ring-foreground/25 ring-2',
        firing.length > 0 && 'border-status-offline/40',
      )}
    >
      <span className="flex items-center gap-2">
        <span aria-hidden className={cn('size-2 shrink-0 rounded-full', TONE_DOT[tone], firing.length && 'animate-pulse motion-reduce:animate-none')} />
        <span className="min-w-0 flex-1 truncate text-[14.5px] font-semibold">{rule.name}</span>
        <span className={cn('shrink-0 font-mono text-[11px] font-semibold', TONE_TEXT[tone])}>{word}</span>
      </span>
      <span className="text-muted-foreground text-[13px] leading-snug">{ruleSentence(rule, channels)}</span>
      <Tech always className="text-[11px]">
        {line}
      </Tech>
      <Tech className="text-[11px]">{rawExpression(rule)}</Tech>
    </button>
  );
}
