import * as React from 'react';
import { cn } from '@swarmy/ui';
import { foldSlots, sleptWords, type SimSlot } from './sleep-sim';

/** 5-minute slots folded into 30-minute bars: 48 across the day, as on the board. */
const PER_BAR = 6;
const BAR_MS = PER_BAR * 5 * 60_000;
const hhmm = (t: number): string => new Date(t).toTimeString().slice(0, 5);

function Swatch({ className, children }: { className: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={cn('inline-block size-2.5 rounded-[3px]', className)} />
      {children}
    </span>
  );
}

/**
 * Yesterday's requests as bars, with a blue wash where the service would
 * have been asleep. Hover a bar for its half hour.
 */
export function SleepChart({ slots, label }: { slots: SimSlot[]; label: string }): React.JSX.Element {
  const bars = React.useMemo(() => foldSlots(slots, PER_BAR), [slots]);
  const max = Math.max(1, ...bars.map((b) => b.calls));
  const [hover, setHover] = React.useState<number | null>(null);
  const onMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const box = e.currentTarget.getBoundingClientRect();
    const i = Math.floor(((e.clientX - box.left) / box.width) * bars.length);
    setHover(Math.max(0, Math.min(bars.length - 1, i)));
  };
  const h = hover !== null ? bars[hover] : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative">
        <div role="img" aria-label={label} className="flex h-16 items-end gap-px" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          {bars.map((b, i) => {
            const slept = b.asleepMs / BAR_MS;
            return (
              <span key={b.t} className={cn('relative h-full min-w-0 flex-1', hover === i && 'bg-foreground/5')}>
                {slept > 0 ? (
                  <span className={cn('absolute inset-0 rounded-[2px]', slept >= 0.5 ? 'bg-status-progress/35' : 'bg-status-progress/15')} />
                ) : null}
                <span
                  className={cn('absolute inset-x-0 bottom-0 rounded-t-[2px]', b.calls > 0 ? 'bg-foreground/45' : 'bg-border')}
                  style={{ height: b.calls > 0 ? `max(2px, ${(b.calls / max) * 100}%)` : 1 }}
                />
              </span>
            );
          })}
        </div>
        {h ? (
          <span
            aria-hidden
            className="bg-popover text-popover-foreground pointer-events-none absolute -top-8 rounded-md border px-2 py-1 font-mono text-[11px] whitespace-nowrap shadow-sm"
            style={hover! / bars.length > 0.6 ? { right: `${100 - ((hover! + 1) / bars.length) * 100}%` } : { left: `${(hover! / bars.length) * 100}%` }}
          >
            {hhmm(h.t)}–{hhmm(h.t + BAR_MS)} · {h.calls.toLocaleString()} requests
            {h.asleepMs > 0 ? ` · asleep ${sleptWords(h.asleepMs)}` : ''}
          </span>
        ) : null}
      </div>
      <span className="text-muted-foreground flex justify-between font-mono text-[10.5px]">
        <span>00:00</span>
        <span>06:00</span>
        <span>12:00</span>
        <span>18:00</span>
        <span>24:00</span>
      </span>
      <span className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-[11.5px]">
        <Swatch className="bg-foreground/45">requests</Swatch>
        <Swatch className="bg-status-progress/35">would have slept</Swatch>
      </span>
    </div>
  );
}
