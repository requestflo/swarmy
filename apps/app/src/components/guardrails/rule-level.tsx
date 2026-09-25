import * as React from 'react';
import { cn } from '@swarmy/ui';

export type RuleLevel = 'block' | 'warn' | 'off';

const LEVELS: { v: RuleLevel; label: string; on: string }[] = [
  { v: 'block', label: 'Block', on: 'bg-status-offline/10 text-tone-bad' },
  { v: 'warn', label: 'Warn', on: 'bg-status-warning/[0.07] text-tone-warn' },
  { v: 'off', label: 'Off', on: 'bg-surface-2 text-foreground dark:bg-accent' },
];

/** Block · Warn · Off — one guardrail's level. */
export function RuleLevelSwitch({
  value,
  onChange,
  disabled,
  label,
}: {
  value: RuleLevel;
  onChange: (v: RuleLevel) => void;
  disabled?: boolean;
  label: string;
}): React.JSX.Element {
  return (
    <div role="group" aria-label={label} className="border-border bg-background inline-flex gap-0.5 rounded-[10px] border p-0.5">
      {LEVELS.map((l) => (
        <button
          key={l.v}
          type="button"
          aria-pressed={value === l.v}
          disabled={disabled}
          onClick={() => onChange(l.v)}
          className={cn(
            'h-7 rounded-[8px] px-2.5 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-60 pointer-coarse:min-h-11',
            value === l.v ? l.on : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}
