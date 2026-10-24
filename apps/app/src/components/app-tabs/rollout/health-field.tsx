import * as React from 'react';
import { Input, cn } from '@swarmy/ui';

/**
 * One knob of the health check (Controls): a plain-words label, a number
 * with its unit, and what blank means (Docker's default), said underneath.
 */
export function HealthField({
  label,
  value,
  onChange,
  unit,
  dflt,
  hint,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  unit: string;
  /** Docker's default, shown as the placeholder and said when blank. */
  dflt: string;
  hint: string;
  disabled?: boolean;
}): React.JSX.Element {
  const id = React.useId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-muted-foreground text-[12px]">
        {label}
      </label>
      <div className="flex items-center gap-1.5">
        <Input
          id={id}
          inputMode="decimal"
          value={value}
          placeholder={dflt}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className={cn('h-8 w-20 font-mono text-[13px] pointer-coarse:min-h-11', disabled && 'opacity-60')}
        />
        <span className="text-muted-foreground font-mono text-[12px]">{unit}</span>
      </div>
      <span className="text-muted-foreground text-[11.5px] leading-snug">{value.trim() === '' ? `Docker’s default, ${dflt} ${unit}` : hint}</span>
    </div>
  );
}
