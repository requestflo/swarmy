import * as React from 'react';
import type { AlertEventView, AlertRuleView, NotificationChannelView } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { TONE_DOT, TONE_TEXT, Tech, type Tone } from '@/components/calm';
import { relTime } from '@/lib/format';
import { rawExpression } from './rule-facts';
import { clockTime, isMuted, resourceName, ruleSentence } from './rule-sentence';

interface RuleCardProps {
  rule: AlertRuleView;
  channels: NotificationChannelView[];
  firing: AlertEventView[];
  lastFired: AlertEventView | undefined;
  selected: boolean;
  onSelect: () => void;
}

/** "held for quiet hours" / "muted" when an open event's message hasn't gone out. */
function heldWords(firing: AlertEventView[]): string {
  if (firing.some((e) => e.notify === 'held')) return ' · held for quiet hours';
  return '';
}

/**
 * One rule as a quiet card: name, a status word (firing · muted · off ·
 * quiet), the sentence with its target, and a mono line of what it last saw.
 * A muted rule reads "muted" in the idle tone with "until 11:40" in the line.
 */
export function RuleCard({ rule, channels, firing, lastFired, selected, onSelect }: RuleCardProps): React.JSX.Element {
  const critical = firing.some((e) => e.severity === 'critical');
  const muted = rule.enabled && isMuted(rule);
  const [tone, word]: [Tone, string] = muted
    ? ['idle', 'muted']
    : firing.length
      ? [critical ? 'bad' : 'warn', 'firing']
      : !rule.enabled
        ? ['idle', 'off']
        : ['ok', 'quiet'];
  const dot: Tone = firing.length ? (critical ? 'bad' : 'warn') : tone;
  const first = firing[0];
  const seen = first
    ? `${firing.map((e) => resourceName(e.resource)).join(', ')} · since ${relTime(first.firedAt)}${heldWords(firing)}`
    : lastFired
      ? `last fired ${relTime(lastFired.firedAt)} · ${resourceName(lastFired.resource)}`
      : 'hasn’t fired lately';
  const line = muted && rule.mutedUntil ? `until ${clockTime(rule.mutedUntil)}${first ? ` · ${seen}` : ''}` : seen;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'calm-card flex w-full flex-col gap-1.5 px-4 py-3.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        'hover:bg-foreground/[0.025]',
        selected && 'ring-foreground/25 ring-2',
        firing.length > 0 && !muted && 'border-status-offline/40',
      )}
    >
      <span className="flex items-center gap-2">
        <span aria-hidden className={cn('size-2 shrink-0 rounded-full', TONE_DOT[dot], firing.length && !muted && 'animate-pulse motion-reduce:animate-none')} />
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
