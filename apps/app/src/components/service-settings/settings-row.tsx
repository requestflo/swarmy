import * as React from 'react';
import { cn } from '@swarmy/ui';

/** One labelled block of the settings panel, divided from the next by a hairline. */
export function SettingRow({
  title,
  hint,
  children,
  className,
}: {
  title: React.ReactNode;
  /** Mono note beside the title ("reserved · limit · used"). */
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  const id = React.useId();
  return (
    <section aria-labelledby={id} className={cn('border-border flex flex-col gap-2 border-t py-3.5 first:border-t-0', className)}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h3 id={id} className="text-[13.5px] font-semibold">
          {title}
        </h3>
        {hint ? <span className="text-muted-foreground font-mono text-[11px]">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

export interface SegOption<T extends string | number> {
  value: T;
  label: string;
}

/**
 * A one-tap choice (presets, "On failure · Always · Never"). Each option is a
 * real button with `aria-pressed`; 44px tall on touch screens.
 */
export function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
  mono,
  disabled,
}: {
  label: string;
  options: readonly SegOption<T>[];
  value: T | undefined;
  onChange: (v: T) => void;
  mono?: boolean;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <div role="group" aria-label={label} className="border-border bg-background inline-flex w-fit max-w-full flex-wrap gap-0.5 rounded-[10px] border p-0.5">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              'h-8 min-w-11 rounded-[8px] px-3 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50 pointer-coarse:min-h-11',
              mono && 'font-mono text-[12.5px]',
              on ? 'bg-surface-2 text-foreground font-semibold ring-1 ring-foreground/25 dark:bg-accent' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** A mono chip (labels, ports). */
export function MonoChip({ children, className }: { children: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <span className={cn('bg-muted text-foreground/90 inline-flex max-w-full items-center rounded-md px-2 py-0.5 font-mono text-[11.5px] break-all', className)}>
      {children}
    </span>
  );
}
