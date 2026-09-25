import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { cn } from '@swarmy/ui';
import { Depth } from './depth';
import { TONE_DOT, TONE_TEXT, type Tone } from './tone';

/**
 * A flat hairline row: dot · name (+ host) · the plain sentence · the tech
 * line (Controls up) · the status word. Rows live inside one `Section`, never
 * as per-row cards. Pass `to` for a link row, `onClick` for a button row.
 */
export function CalmRow({
  tone = 'ok',
  name,
  sub,
  say,
  tech,
  word,
  wordTone,
  to,
  params,
  onClick,
  trailing,
  className,
}: {
  tone?: Tone;
  name: React.ReactNode;
  sub?: React.ReactNode;
  say?: React.ReactNode;
  tech?: React.ReactNode;
  word?: React.ReactNode;
  wordTone?: Tone;
  to?: string;
  params?: Record<string, string>;
  onClick?: () => void;
  trailing?: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  const body = (
    <>
      <span aria-hidden className={cn('size-2 shrink-0 rounded-full', TONE_DOT[tone])} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:w-48 sm:flex-none sm:shrink-0">
        <span className="truncate text-[14.5px] font-semibold">{name}</span>
        {sub ? <span className="text-muted-foreground truncate font-mono text-[11px]">{sub}</span> : null}
        {say ? <span className="text-muted-foreground text-[13px] leading-snug sm:hidden">{say}</span> : null}
      </span>
      <span className="text-muted-foreground hidden min-w-0 flex-1 text-[13px] sm:block">{say}</span>
      {tech ? (
        <Depth at="controls">
          <span className="text-muted-foreground hidden max-w-[260px] shrink-0 truncate text-right font-mono text-[11.5px] lg:block">
            {tech}
          </span>
        </Depth>
      ) : null}
      {trailing}
      {word ? (
        <span className={cn('ml-auto shrink-0 text-xs font-semibold sm:ml-0', TONE_TEXT[wordTone ?? tone])}>{word}</span>
      ) : null}
    </>
  );
  const cls = cn(
    'border-border flex min-h-14 items-center gap-3 border-b px-1 py-2 text-left last:border-b-0 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 rounded-sm',
    (to || onClick) && 'hover:bg-foreground/[0.025]',
    className,
  );
  if (to) {
    return (
      <Link to={to} params={params as never} className={cls}>
        {body}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={cn(cls, 'w-full')}>
        {body}
      </button>
    );
  }
  return <div className={cls}>{body}</div>;
}

/** A quiet list of `CalmRow`s. */
export function RowList({ children, label }: { children: React.ReactNode; label?: string }): React.JSX.Element {
  return (
    <div aria-label={label} className="flex flex-col">
      {children}
    </div>
  );
}
