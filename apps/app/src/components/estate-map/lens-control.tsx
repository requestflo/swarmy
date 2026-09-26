import * as React from 'react';
import { cn } from '@swarmy/ui';

export type Lens = 'traffic' | 'mesh' | 'cost';

const LENSES: { id: Lens; label: string }[] = [
  { id: 'traffic', label: 'Traffic' },
  { id: 'mesh', label: 'Private network' },
  { id: 'cost', label: 'Cost' },
];

/** Traffic · Private network · Cost: what the map colours in. */
export function LensControl({ lens, onChange }: { lens: Lens; onChange: (l: Lens) => void }): React.JSX.Element {
  return (
    <div role="group" aria-label="Show on the map" className="border-border bg-card inline-flex rounded-[10px] border p-0.5">
      {LENSES.map((l) => (
        <button
          key={l.id}
          type="button"
          aria-pressed={lens === l.id}
          onClick={() => onChange(l.id)}
          className={cn(
            'inline-flex h-8 items-center rounded-[8px] px-3 text-[13px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:min-h-11',
            lens === l.id ? 'bg-surface-2 text-foreground dark:bg-accent' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}
