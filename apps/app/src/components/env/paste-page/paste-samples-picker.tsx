import * as React from 'react';
import { cn } from '@swarmy/ui';
import { PASTE_SAMPLES } from './paste-samples';

/** "sample · heroku export · .env.production": load a format sample to see how the parser reads it. */
export function PasteSamples({ onPick }: { onPick: (text: string) => void }): React.JSX.Element {
  const [on, setOn] = React.useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground font-mono text-[11px]">try a format</span>
      <div role="group" aria-label="Paste sample" className="border-border bg-background inline-flex flex-wrap gap-0.5 rounded-[10px] border p-0.5">
        {PASTE_SAMPLES.map((s) => (
          <button
            key={s.key}
            type="button"
            aria-pressed={on === s.key}
            onClick={() => {
              setOn(s.key);
              onPick(s.text);
            }}
            className={cn(
              'h-7 rounded-[8px] px-2.5 font-mono text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:min-h-11',
              on === s.key ? 'bg-surface-2 text-foreground font-semibold dark:bg-accent' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {s.label}
          </button>
        ))}
      </div>
      <span className="text-muted-foreground text-xs">replaces the box · placeholders only</span>
    </div>
  );
}
