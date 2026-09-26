import * as React from 'react';
import { cn } from '@swarmy/ui';

/** The TRY chips under the input: tap one to type it. The one you're on stays marked. */
export function PaletteTry({ examples, query, onPick }: { examples: string[]; query: string; onPick: (q: string) => void }): React.JSX.Element | null {
  if (!examples.length) return null;
  const q = query.trim().toLowerCase();
  return (
    <div className="text-muted-foreground flex min-h-10 flex-wrap items-center gap-2 border-b px-3 py-1.5 text-[12px]">
      <span className="calm-eyebrow">Try</span>
      {examples.map((x) => (
        <button
          key={x}
          type="button"
          aria-pressed={q === x}
          onClick={() => onPick(x)}
          className={cn(
            'rounded-full border px-2.5 py-0.5 pointer-coarse:min-h-11',
            q === x ? 'border-foreground/40 text-foreground bg-foreground/[0.06]' : 'border-border hover:text-foreground hover:border-foreground/30',
          )}
        >
          {x}
        </button>
      ))}
    </div>
  );
}
