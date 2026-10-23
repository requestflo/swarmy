import * as React from 'react';
import { cn } from '@swarmy/ui';
import { PLATFORMS, type PlatformId } from './platforms';

/** "Where is the server?" — the platform tabs above the install line. */
export function PlatformTabs({ value, onChange }: { value: PlatformId; onChange: (p: PlatformId) => void }): React.JSX.Element {
  return (
    <div role="tablist" aria-label="Where is the server" className="flex flex-wrap gap-2">
      {PLATFORMS.map((p) => (
        <button
          key={p.id}
          type="button"
          role="tab"
          aria-selected={p.id === value}
          onClick={() => onChange(p.id)}
          className={cn(
            'bg-card h-10 rounded-[11px] border px-3.5 text-[13.5px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:min-h-11',
            p.id === value
              ? 'border-primary text-foreground shadow-[0_0_0_3px_color-mix(in_oklab,var(--primary)_16%,transparent)]'
              : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/25',
          )}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
