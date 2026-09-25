import * as React from 'react';
import { cn } from '@swarmy/ui';

export type ChipTone = 'neutral' | 'online' | 'warning' | 'offline' | 'progress';

const TONE: Record<ChipTone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  online: 'border border-status-online/50 text-tone-ok',
  warning: 'border border-status-warning/60 text-tone-warn',
  offline: 'border border-status-offline/50 text-tone-bad',
  progress: 'border border-status-progress/50 text-tone-info',
};

/** A small status pill ("inputs masked", "cookieless · no personal data"). */
export function Chip({
  tone = 'neutral',
  mono = false,
  className,
  children,
}: {
  tone?: ChipTone;
  mono?: boolean;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap',
        mono && 'font-mono',
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

interface SegmentedProps<T extends string | number> {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}

/** A radio group drawn as one pill of choices (sample rate, keep-for, mode). */
export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
  disabled,
}: SegmentedProps<T>): React.JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="bg-muted inline-flex flex-wrap gap-0.5 rounded-full p-0.5"
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              'rounded-full px-3 py-1 font-mono text-xs font-semibold transition-colors disabled:opacity-50',
              on ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** A titled card section, the building block of the settings page. */
export function RumSection({
  title,
  badge,
  action,
  className,
  children,
}: {
  title: string;
  badge?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className={cn('calm-card shadow-none space-y-3 p-5', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-bold">{title}</h2>
        {badge}
        {action ? <div className="ml-auto">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}
