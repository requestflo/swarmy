import * as React from 'react';
import { cn } from '@swarmy/ui';
import { clock } from './rum-shared';
import type { Tick, TickKind } from './replay-timeline';

export const TICK_COLOR: Record<TickKind, string> = {
  page: 'bg-status-progress',
  click: 'bg-muted-foreground',
  net: 'bg-status-online',
  error: 'bg-status-offline',
};

interface ReplayScrubberProps {
  ticks: Tick[];
  time: number;
  total: number;
  onSeek: (t: number) => void;
}

/**
 * The timeline: one coloured tick per page load, click, request and error;
 * click anywhere to seek, or on a tick to land exactly on it. Arrow keys
 * step 5 s.
 */
export function ReplayScrubber({ ticks, time, total, onSeek }: ReplayScrubberProps): React.JSX.Element {
  const track = React.useRef<HTMLDivElement>(null);
  const span = Math.max(1, total);
  const pos = (t: number): string => `${(Math.min(t, span) / span) * 100}%`;

  const seekFromPointer = (e: React.MouseEvent): void => {
    const r = track.current?.getBoundingClientRect();
    if (!r || r.width === 0) return;
    onSeek(((e.clientX - r.left) / r.width) * span);
  };

  return (
    <div
      ref={track}
      role="slider"
      tabIndex={0}
      aria-label="Replay timeline"
      aria-valuemin={0}
      aria-valuemax={Math.round(span / 1000)}
      aria-valuenow={Math.round(time / 1000)}
      aria-valuetext={`${clock(time)} of ${clock(span)}`}
      onClick={seekFromPointer}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') onSeek(time + 5000);
        if (e.key === 'ArrowLeft') onSeek(time - 5000);
      }}
      className="bg-muted/60 border-border focus-visible:ring-primary relative h-9 cursor-pointer rounded-lg border outline-none focus-visible:ring-2"
    >
      {ticks.map((k, i) => (
        <button
          key={i}
          type="button"
          title={`${clock(k.t)} · ${k.label}`}
          aria-label={`Jump to ${clock(k.t)} · ${k.label}`}
          onClick={(e) => {
            e.stopPropagation();
            onSeek(k.t);
          }}
          className={cn(
            'absolute rounded-sm hover:scale-y-110',
            TICK_COLOR[k.kind],
            k.kind === 'error' ? 'top-1 h-7 w-1' : 'top-2 h-5 w-[3px]',
          )}
          style={{ left: `calc(${pos(k.t)} - 1px)` }}
        />
      ))}
      <span
        aria-hidden
        className="bg-primary pointer-events-none absolute -top-1 -bottom-1 w-0.5 rounded-full shadow-[0_0_8px_var(--primary)]"
        style={{ left: `calc(${pos(time)} - 1px)` }}
      />
    </div>
  );
}
