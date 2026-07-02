import * as React from 'react';
import type { ServiceSummary } from '@swarmy/core';
import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@swarmy/ui';

/** Compact labelled number field for the start-canary dialog's tuning row. */
export function CanaryField({
  label,
  min,
  max,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (v: number) => void;
}): React.JSX.Element {
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      <Input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="text-right font-mono"
      />
    </div>
  );
}

/** Stable-service picker (canary siblings are excluded upstream). */
export function CanaryServicePicker({
  candidates,
  loading,
  value,
  selected,
  onChange,
}: {
  candidates: ServiceSummary[];
  loading: boolean;
  value: string;
  selected: ServiceSummary | undefined;
  onChange: (name: string) => void;
}): React.JSX.Element {
  return (
    <div className="grid gap-1.5">
      <Label className="text-sm font-medium">Service</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue placeholder={loading ? 'Loading services…' : 'Pick a service'} />
        </SelectTrigger>
        <SelectContent>
          {candidates.map((s) => (
            <SelectItem key={s.id} value={s.name}>
              {s.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {selected ? (
        <p className="text-muted-foreground font-mono text-xs">currently {selected.image}</p>
      ) : null}
    </div>
  );
}
