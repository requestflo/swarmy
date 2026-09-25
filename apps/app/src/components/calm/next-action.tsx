import * as React from 'react';
import { cn } from '@swarmy/ui';
import { Tech } from './tech';
import { TONE_DOT, type Tone } from './tone';

/**
 * "Needs you": the one thing worth doing now — what happened, why the fix is
 * safe, the coral button. Pass the button in `actions`; it is the screen's
 * single coral action. `tech` is the Controls-depth detail line.
 */
export function NextAction({
  title,
  children,
  tech,
  actions,
  hint,
  since,
  tone = 'warn',
  eyebrow,
  className,
}: {
  title: React.ReactNode;
  children?: React.ReactNode;
  tech?: React.ReactNode;
  actions?: React.ReactNode;
  /** A quiet trailing hint after the buttons ("or press ⌘K…"). */
  hint?: React.ReactNode;
  since?: string;
  tone?: Tone;
  eyebrow?: string;
  className?: string;
}): React.JSX.Element {
  return (
    <section aria-label={eyebrow ?? 'Needs you'} className={cn('calm-next flex flex-col gap-2.5 px-5 py-4', className)}>
      {eyebrow ? <span className="calm-eyebrow text-primary">{eyebrow}</span> : null}
      <div className="flex items-start gap-2.5">
        <span aria-hidden className={cn('mt-[7px] size-2 shrink-0 rounded-full', TONE_DOT[tone])} />
        <h2 className="text-[15px] leading-snug font-semibold">{title}</h2>
        {since ? <span className="text-muted-foreground ml-auto shrink-0 font-mono text-[11px]">{since}</span> : null}
      </div>
      {children ? <div className="text-muted-foreground text-[13.5px] leading-relaxed">{children}</div> : null}
      {tech ? <Tech>{tech}</Tech> : null}
      {actions || hint ? (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {actions}
          {hint ? <span className="text-muted-foreground ml-1 text-xs">{hint}</span> : null}
        </div>
      ) : null}
    </section>
  );
}
