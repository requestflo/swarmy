import * as React from 'react';
import { cn } from '@swarmy/ui';
import { API_KEY_PRESET_ORDER, API_KEY_PRESETS, type ApiKeyPreset } from '@swarmy/core';
import { Tech } from '@/components/calm';

/** "It can": Read-only / Deploy / Admin as three pressable cards; scopes at Controls. */
export function PresetCards({ value, onChange }: { value: ApiKeyPreset; onChange: (p: ApiKeyPreset) => void }): React.JSX.Element {
  return (
    <div role="group" aria-label="It can" className="grid grid-cols-3 gap-2">
      {API_KEY_PRESET_ORDER.map((p) => {
        const info = API_KEY_PRESETS[p];
        const on = value === p;
        return (
          <button
            key={p}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(p)}
            className={cn(
              'flex min-h-[4.5rem] flex-col items-start gap-0.5 rounded-[10px] border px-3 py-2 text-left outline-none transition-colors',
              'focus-visible:ring-ring/60 focus-visible:ring-2',
              on ? 'border-primary/70 bg-primary/8' : 'border-border hover:bg-foreground/[0.04]',
            )}
          >
            <span className="text-[13.5px] font-semibold">{info.label}</span>
            <span className="text-muted-foreground text-[11.5px] leading-snug">{info.blurb}</span>
            <Tech className="mt-auto">{info.scopes.join(' · ')}</Tech>
          </button>
        );
      })}
    </div>
  );
}
