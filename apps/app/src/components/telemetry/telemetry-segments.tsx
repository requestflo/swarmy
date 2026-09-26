import * as React from 'react';
import { cn } from '@swarmy/ui';

/** A radio group drawn as one row of choices (share kept, days kept). Never coral. */
export function Segments<T extends number>({
  label,
  value,
  options,
  onChange,
  format,
  disabled,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
  format: (v: T) => string;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <div role="radiogroup" aria-label={label} className="border-border bg-background inline-flex w-fit flex-wrap gap-0.5 rounded-[10px] border p-0.5">
      {options.map((o) => {
        const on = o === value;
        return (
          <button
            key={o}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(o)}
            className={cn(
              'h-8 min-w-11 rounded-[8px] px-2.5 font-mono text-[12px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50 pointer-coarse:min-h-11',
              on ? 'bg-surface-2 text-foreground shadow-sm dark:bg-accent' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {format(o)}
          </button>
        );
      })}
    </div>
  );
}
