import * as React from 'react';
import { cn } from '@swarmy/ui';
import type { RetentionPreview } from './retention-preview';

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Tue 23 Sep 03:00" (UTC, like the scrubber). */
export function pointTime(ms: number, withDay = true): string {
  const d = new Date(ms);
  const date = `${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;
  const hm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  return withDay ? `${WEEKDAY[d.getUTCDay()]} ${date} ${hm}` : date;
}

/** The window choices: 7 d · 14 d · 30 d · 90 d (and a custom current one). */
export function RetentionNotch({ choices, value, onChange, disabled }: {
  choices: number[];
  value: number;
  onChange: (d: number) => void;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <div role="group" aria-label="Keep window" className="bg-surface-2 dark:bg-accent inline-flex gap-0.5 rounded-[10px] p-0.5">
      {choices.map((d) => (
        <button
          key={d}
          type="button"
          aria-pressed={d === value}
          disabled={disabled}
          onClick={() => onChange(d)}
          className={cn(
            'h-7 rounded-[8px] px-2.5 font-mono text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50 pointer-coarse:min-h-11',
            d === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {d} d
        </button>
      ))}
    </div>
  );
}

/** Restore points along the keep window: green stays, faded red would go; click one to pick it. */
export function RetentionStrip({ preview, selected, onSelect }: {
  preview: RetentionPreview;
  selected: string | null;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  const mid = preview.fromMs + (preview.toMs - preview.fromMs) / 2;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative h-12">
        <div aria-hidden className="bg-border absolute inset-x-2 top-1/2 h-px" />
        <div
          aria-hidden
          className="border-status-online/40 bg-status-online/[0.07] absolute top-1/2 right-0 h-6 -translate-y-1/2 rounded-full border border-dashed transition-[width] duration-300 motion-reduce:transition-none"
          style={{ width: `${(preview.keepFrac * 100).toFixed(2)}%` }}
        />
        {preview.points.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-label={`Saved ${pointTime(p.timeMs)} UTC${p.keep ? '' : ', would go'}`}
            aria-pressed={p.id === selected}
            onClick={() => onSelect(p.id)}
            className={cn(
              'absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full outline-none transition-all duration-300 motion-reduce:transition-none',
              'before:absolute before:-inset-2 before:content-[""] focus-visible:ring-2 focus-visible:ring-ring/60',
              p.keep ? 'bg-status-online' : 'bg-status-offline/35 scale-75',
              p.id === selected && 'ring-primary/50 ring-4',
            )}
            style={{ left: `calc(8px + (100% - 16px) * ${p.frac.toFixed(4)})` }}
          />
        ))}
      </div>
      <div className="text-muted-foreground flex justify-between font-mono text-[11px]">
        <span>{pointTime(preview.fromMs, false)}</span>
        <span>{pointTime(mid, false)}</span>
        <span>today</span>
      </div>
    </div>
  );
}
