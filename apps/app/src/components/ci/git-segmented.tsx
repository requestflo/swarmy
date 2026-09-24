import * as React from 'react';
import { cn } from '@swarmy/ui';

interface GitSegmentedProps<T extends string> {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
}

/** A small pill toggle for choosing between two or three modes of one form. */
export function GitSegmented<T extends string>({
  value,
  options,
  onChange,
}: GitSegmentedProps<T>): React.JSX.Element {
  return (
    <div role="radiogroup" className="bg-accent/40 inline-flex flex-wrap rounded-full p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-full px-3.5 py-1 text-sm font-semibold transition-colors',
            value === o.value
              ? 'bg-background shadow-xs'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
