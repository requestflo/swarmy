import * as React from 'react';
import { cn } from '@swarmy/ui';
import type { Tone } from '@/components/calm';

/** Soft tone washes for the Stream's status pills (tone text, status fills). */
const WASH: Record<Tone, string> = {
  ok: 'bg-status-online/12 text-tone-ok',
  warn: 'bg-status-warning/14 text-tone-warn',
  bad: 'bg-status-offline/12 text-tone-bad',
  info: 'bg-status-progress/12 text-tone-info',
  mesh: 'bg-tone-mesh/12 text-tone-mesh',
  idle: 'bg-muted text-tone-idle',
};

/** ok · firing · open · suspect · resolved, in its tone. */
export function StreamPill({ word, tone }: { word: string; tone: Tone }): React.JSX.Element {
  return <span className={cn('rounded-full px-2 py-px text-[11px] leading-[18px] font-semibold', WASH[tone])}>{word}</span>;
}
