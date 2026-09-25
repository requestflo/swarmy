import * as React from 'react';
import { cn } from '@swarmy/ui';
import { DepthScope, useDepth, type DepthName } from './depth';
import { DepthSegments } from './depth-dial';

/**
 * A quiet section card: an h2, an optional count and "→" link, and its body.
 * `switchable` gives the section its own depth switch (it starts at the page's
 * depth and can go its own way).
 */
export function Section({
  title,
  count,
  hint,
  action,
  switchable,
  flush,
  children,
  className,
  id,
}: {
  title: React.ReactNode;
  count?: React.ReactNode;
  /** A quiet note beside the title ("same data, same numbers"). */
  hint?: React.ReactNode;
  /** A link or quiet button at the right of the heading. */
  action?: React.ReactNode;
  switchable?: boolean;
  /** Tighter body padding for row lists. */
  flush?: boolean;
  children: React.ReactNode;
  className?: string;
  id?: string;
}): React.JSX.Element {
  const inherited = useDepth().depth;
  const [own, setOwn] = React.useState<DepthName | null>(null);
  const titleId = React.useId();
  return (
    <section
      id={id}
      aria-labelledby={titleId}
      className={cn('calm-card flex flex-col', flush ? 'px-5 pt-3 pb-1.5' : 'gap-3 px-5 py-4', className)}
    >
      <div className={cn('flex flex-wrap items-center gap-x-2.5 gap-y-1', flush && 'pb-1')}>
        <h2 id={titleId} className="font-display text-[16.5px] font-bold tracking-[-0.01em]">
          {title}
        </h2>
        {count !== undefined ? <span className="text-muted-foreground text-[12.5px]">{count}</span> : null}
        {hint ? <span className="text-muted-foreground text-xs">{hint}</span> : null}
        <div className="ml-auto flex items-center gap-2">
          {action}
          {switchable ? (
            <DepthSegments value={own ?? inherited} onChange={setOwn} label="Detail in this section" size="sm" />
          ) : null}
        </div>
      </div>
      <DepthScope depth={switchable ? own : null}>
        {children}
      </DepthScope>
    </section>
  );
}

/** The mono "All apps →" style link used in section headings. */
export function SectionLink({ children, ...rest }: React.ComponentProps<'span'>): React.JSX.Element {
  return (
    <span className="text-primary font-mono text-[11.5px] hover:underline" {...rest}>
      {children}
    </span>
  );
}
