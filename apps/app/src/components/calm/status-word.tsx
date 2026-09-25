import * as React from 'react';
import { cn } from '@swarmy/ui';
import { TONE_DOT, TONE_TEXT, type Tone } from './tone';

/** One status vocabulary everywhere: Online · Deploying · Needs you · Offline · Idle. */
export const STATUS_WORD: Record<Tone, string> = {
  ok: 'Online',
  info: 'Deploying',
  warn: 'Needs you',
  bad: 'Offline',
  idle: 'Idle',
  mesh: 'Private',
};

export function StatusWord({
  tone,
  word,
  pulse,
  className,
}: {
  tone: Tone;
  word?: string;
  pulse?: boolean;
  className?: string;
}): React.JSX.Element {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs font-semibold', TONE_TEXT[tone], className)}>
      <span aria-hidden className={cn('size-2 rounded-full', TONE_DOT[tone], pulse && 'animate-pulse motion-reduce:animate-none')} />
      {word ?? STATUS_WORD[tone]}
    </span>
  );
}
