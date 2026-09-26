import * as React from 'react';
import { cn } from '@swarmy/ui';

/** A quiet segmented choice (`aria-pressed` buttons). The picked one gets the soft wash, not coral. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  mono,
  disabled,
}: {
  value: T;
  options: Array<{ value: T; label: React.ReactNode; disabled?: boolean }>;
  onChange: (v: T) => void;
  label: string;
  mono?: boolean;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <div role="group" aria-label={label} className="border-border bg-background inline-flex max-w-full flex-wrap gap-0.5 rounded-[10px] border p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          disabled={disabled || o.disabled}
          onClick={() => onChange(o.value)}
          className={cn(
            'min-h-8 rounded-[8px] px-3 text-[12.5px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50 pointer-coarse:min-h-11',
            mono && 'font-mono text-[12px]',
            value === o.value ? 'bg-surface-2 text-foreground dark:bg-accent ring-border ring-1' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
