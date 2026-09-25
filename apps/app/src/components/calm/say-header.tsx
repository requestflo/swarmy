import * as React from 'react';
import { cn } from '@swarmy/ui';
import { TONE_TEXT, type Tone } from './tone';

/**
 * The sentence headline — what the screen *is*, said plainly, with the clause
 * that matters in its status tone: "Three apps are calm. <Say tone="warn">
 * analytics is slow.</Say>". `<em>` renders as the quieter second clause.
 */
export function SayHeader({
  eyebrow,
  title,
  lede,
  actions,
  size = 'lg',
  className,
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  lede?: React.ReactNode;
  /** The screen's one coral action (and at most one quiet sibling). */
  actions?: React.ReactNode;
  size?: 'lg' | 'md';
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-x-6 gap-y-4', className)}>
      <div className="flex min-w-0 max-w-4xl flex-col gap-2">
        {eyebrow ? <span className="calm-eyebrow">{eyebrow}</span> : null}
        <h1 className={cn('say', size === 'lg' ? 'text-[1.9rem] sm:text-[2.25rem]' : 'text-2xl sm:text-[1.7rem]')}>
          {title}
        </h1>
        {lede ? <p className="lede max-w-3xl text-[15px] sm:text-[15.5px]">{lede}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** A clause in a status tone, inside a `SayHeader` title or any sentence. */
export function Say({ tone, children }: { tone: Tone; children: React.ReactNode }): React.JSX.Element {
  return <span className={TONE_TEXT[tone]}>{children}</span>;
}
