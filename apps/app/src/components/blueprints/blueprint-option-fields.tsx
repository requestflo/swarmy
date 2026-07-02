import * as React from 'react';
import type { BlueprintOptionView, BlueprintSize } from '@swarmy/core';
import { cn, Input, Switch } from '@swarmy/ui';

const SIZE_HINTS: Record<BlueprintSize, string> = {
  s: 'Solo — 1 replica, no DB replicas',
  m: 'Team — 2 replicas, 1 DB replica',
  l: 'Scale — 3 replicas, HA data',
};

/** The S/M/L segmented picker (drives replica + memory presets server-side). */
export function BlueprintSizePicker({
  value,
  onChange,
}: {
  value: BlueprintSize;
  onChange: (size: BlueprintSize) => void;
}): React.JSX.Element {
  return (
    <div>
      <span className="mono-label">Size</span>
      <div className="mt-2 grid grid-cols-3 gap-2">
        {(['s', 'm', 'l'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onChange(s)}
            className={cn(
              'rounded-xl border px-3 py-2 text-left transition-colors',
              value === s ? 'border-primary bg-primary/10' : 'hover:bg-accent',
            )}
          >
            <span className="mono-data text-sm font-bold uppercase">{s}</span>
            <span className="text-muted-foreground mt-0.5 block text-[11px] leading-tight">
              {SIZE_HINTS[s]}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** One catalog-declared per-blueprint option (string input or boolean switch). */
export function BlueprintOptionField({
  option,
  value,
  onChange,
}: {
  option: BlueprintOptionView;
  value: string | boolean | undefined;
  onChange: (value: string | boolean) => void;
}): React.JSX.Element {
  if (option.kind === 'boolean') {
    return (
      <div className="flex items-center justify-between gap-3">
        <div>
          <span className="text-sm font-medium">{option.label}</span>
          {option.help ? <p className="text-muted-foreground text-xs">{option.help}</p> : null}
        </div>
        <Switch
          checked={Boolean(value ?? option.defaultValue)}
          onCheckedChange={onChange}
        />
      </div>
    );
  }
  return (
    <div className="grid gap-1.5">
      <span className="mono-label">{option.label}</span>
      <Input
        className="font-mono"
        placeholder={option.placeholder}
        value={String(value ?? option.defaultValue ?? '')}
        onChange={(e) => onChange(e.target.value)}
      />
      {option.help ? <p className="text-muted-foreground text-xs">{option.help}</p> : null}
    </div>
  );
}
