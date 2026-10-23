import * as React from 'react';
import { clockLabel, momentLabel, WEEK_MS } from './time-travel-model';
import { HeadLine } from './travel-lane';
import type { TravelHead } from './use-travel-head';

const DAY_MS = 24 * 60 * 60 * 1000;

interface TravelHeadRowProps {
  head: TravelHead;
  now: number;
  pos: number;
  /** The bar's inner track, measured by the timeline for lane grouping. */
  trackRef: React.RefCallback<HTMLDivElement>;
}

/**
 * The scrub row: press anywhere on it to put the head there and drag it.
 * The knob is a slider — ←/→ step between events (the page's keys), Page
 * Up/Down move a day, Home goes to a week ago and End back to now.
 */
export function TravelHeadRow({ head, now, pos, trackRef }: TravelHeadRowProps): React.JSX.Element {
  const box = React.useRef<HTMLDivElement | null>(null);
  const dragging = React.useRef(false);
  const ref = React.useCallback(
    (el: HTMLDivElement | null) => {
      box.current = el;
      trackRef(el);
    },
    [trackRef],
  );
  const at = (clientX: number): number => {
    const r = box.current?.getBoundingClientRect();
    const share = r && r.width ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) : 1;
    return now - WEEK_MS + share * WEEK_MS;
  };
  const onKey = (e: React.KeyboardEvent): void => {
    const to = { PageUp: head.at - DAY_MS, PageDown: head.at + DAY_MS, Home: now - WEEK_MS, End: now }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    head.go(to);
  };

  return (
    <div
      ref={ref}
      className="relative h-11 cursor-pointer touch-none select-none"
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        head.go(at(e.clientX));
      }}
      onPointerMove={(e) => {
        if (dragging.current) head.go(at(e.clientX));
      }}
      onPointerUp={() => {
        dragging.current = false;
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
    >
      <span aria-hidden className="bg-border absolute top-1/2 right-0 left-0 h-px" />
      <span aria-hidden className="bg-foreground/60 absolute top-1/2 right-0 h-0.5 -translate-y-1/2" style={{ left: `${pos * 100}%` }} />
      <span aria-hidden title="now" className="bg-status-online absolute top-1/2 right-0 size-3 translate-x-1/2 -translate-y-1/2 rounded-full" />
      <HeadLine pos={pos} />
      <button
        type="button"
        role="slider"
        aria-label="Drag to go back in time"
        aria-valuemin={now - WEEK_MS}
        aria-valuemax={now}
        aria-valuenow={Math.round(head.at)}
        aria-valuetext={head.live ? 'now' : momentLabel(head.at)}
        onKeyDown={onKey}
        className="bg-foreground text-background absolute top-1/2 h-7 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full px-2.5 font-mono text-[11px] font-semibold whitespace-nowrap shadow-md outline-none focus-visible:ring-2 focus-visible:ring-ring/60 active:cursor-grabbing pointer-coarse:h-11"
        style={{ left: `${pos * 100}%` }}
      >
        {head.live ? 'now' : clockLabel(head.at)}
      </button>
    </div>
  );
}
