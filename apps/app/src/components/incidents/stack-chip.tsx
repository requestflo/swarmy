import * as React from 'react';
import { Link } from '@tanstack/react-router';

/** Small pill linking into the stack workspace this incident traces back to. */
export function StackChip({ stack }: { stack: string }): React.JSX.Element {
  return (
    <Link
      to="/stacks/$name"
      params={{ name: stack }}
      onClick={(e) => e.stopPropagation()}
      className="bg-accent hover:bg-accent/70 mono-data inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold text-muted-foreground transition-colors"
    >
      {stack}
    </Link>
  );
}
