import * as React from 'react';
import { cn } from '@swarmy/ui';

/** A pill filter chip (category, "Try:" suggestion). Selected = a quiet coral outline. */
export function FilterChip({
  selected,
  onClick,
  children,
  count,
}: {
  selected?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  count?: number;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium transition-colors outline-none pointer-coarse:min-h-11',
        'focus-visible:ring-ring/60 focus-visible:ring-2',
        selected ? 'border-primary/70 bg-primary/8 text-foreground' : 'border-border hover:bg-foreground/[0.04]',
      )}
    >
      {children}
      {count !== undefined ? <span className="text-muted-foreground font-mono text-[11px]">{count}</span> : null}
    </button>
  );
}
