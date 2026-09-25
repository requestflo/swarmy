import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { cn } from '@swarmy/ui';
import { TONE_DOT, TONE_TEXT, Tech, type Tone } from '@/components/calm';

/**
 * A hairline row for longer sentences: dot · name (+ sub) · the sentence with
 * its tech line under it (Controls up) · trailing · status word. Same look as
 * `CalmRow`, but the tech line never squeezes the sentence.
 */
export function LineRow({
  tone = 'ok',
  name,
  sub,
  say,
  tech,
  word,
  wordTone,
  trailing,
  to,
  params,
}: {
  tone?: Tone;
  name: React.ReactNode;
  sub?: React.ReactNode;
  say?: React.ReactNode;
  tech?: React.ReactNode;
  word?: React.ReactNode;
  wordTone?: Tone;
  trailing?: React.ReactNode;
  to?: string;
  params?: Record<string, string>;
}): React.JSX.Element {
  const body = (
    <>
      <span aria-hidden className={cn('mt-[7px] size-2 shrink-0 rounded-full', TONE_DOT[tone])} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:gap-4">
        <span className="flex shrink-0 flex-col gap-0.5 sm:w-44">
          <span className="truncate text-[14.5px] font-semibold">{name}</span>
          {sub ? <span className="text-muted-foreground truncate font-mono text-[11px]">{sub}</span> : null}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          {say ? <span className="text-muted-foreground text-[13px] leading-snug">{say}</span> : null}
          {tech ? <Tech>{tech}</Tech> : null}
        </span>
      </span>
      {trailing ? <span className="flex shrink-0 items-center gap-1">{trailing}</span> : null}
      {word ? <span className={cn('shrink-0 pt-0.5 text-xs font-semibold', TONE_TEXT[wordTone ?? tone])}>{word}</span> : null}
    </>
  );
  const cls = 'border-border flex min-h-14 items-start gap-3 border-b px-1 py-2.5 last:border-b-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50';
  return to ? (
    <Link to={to} params={params as never} className={cn(cls, 'hover:bg-foreground/[0.025]')}>{body}</Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}
