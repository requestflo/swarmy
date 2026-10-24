import * as React from 'react';
import { cn } from '@swarmy/ui';
import { clock, known, lastKnown, seriesPath, slotStart, type HistoryGrid, type Series } from './history-model';

const W = 600;

export interface HistoryChartProps {
  grid: HistoryGrid;
  values: Series;
  /** What one value is, for the tooltip and the summary: "hit rate", "waiting". */
  noun: string;
  format: (v: number) => string;
  /** Top of the scale; defaults to the largest reading. */
  max?: number;
  /** Bottom of the scale (0 unless given; a line only — an area always starts at 0). */
  min?: number;
  /** Staircase line (copies) instead of a slope. */
  step?: boolean;
  /** Fill under the line. */
  area?: boolean;
  /** Plot height in px. */
  height?: number;
  /** A slot highlighted from outside (charts that share a time axis share a crosshair). */
  hover?: number | null;
  onHover?: (i: number | null) => void;
  /** Ink for the line (a `text-*` class; text tokens, never a status fill). */
  tone?: string;
  className?: string;
}

/**
 * One series over a history grid as a quiet SVG: one y-scale, gaps stay
 * gaps, a hover crosshair with the slot's time and value. The summary
 * (newest + highest reading) is the accessible name.
 */
export function HistoryChart({
  grid,
  values,
  noun,
  format,
  max,
  min = 0,
  step,
  area,
  height = 56,
  hover: hoverProp,
  onHover,
  tone = 'text-foreground/70',
  className,
}: HistoryChartProps): React.JSX.Element {
  const [own, setOwn] = React.useState<number | null>(null);
  const hover = hoverProp !== undefined ? hoverProp : own;
  const setHover = (i: number | null): void => (onHover ? onHover(i) : setOwn(i));
  const readings = known(values);
  const top = max ?? Math.max(1, ...readings);
  const n = values.length;
  const last = lastKnown(values);
  const summary = `${noun}: ${last !== null ? `now ${format(last)}` : 'no reading yet'}${readings.length ? `, highest ${format(Math.max(...readings))}` : ''}`;

  const pick = (e: React.PointerEvent<HTMLDivElement>): void => {
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width <= 0 || n === 0) return;
    setHover(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1)))));
  };
  const hv = hover !== null && hover >= 0 && hover < n ? hover : null;
  const x = hv !== null && n > 1 ? (hv / (n - 1)) * 100 : 0;
  const v = hv !== null ? values[hv] : null;

  return (
    <div className={cn('relative', className)} onPointerMove={pick} onPointerLeave={() => setHover(null)}>
      <svg
        viewBox={`0 0 ${W} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={summary}
        className={cn('block w-full overflow-visible', tone)}
        style={{ height }}
      >
        <line x1={0} x2={W} y1={height - 1} y2={height - 1} stroke="currentColor" strokeWidth={1} opacity={0.18} vectorEffect="non-scaling-stroke" />
        {area && min === 0 ? <path d={seriesPath(values, W, height, top, { step, closed: true })} fill="currentColor" opacity={0.12} /> : null}
        <path
          d={seriesPath(values, W, height, top, { step, min })}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        {hv !== null ? (
          <line x1={(x / 100) * W} x2={(x / 100) * W} y1={0} y2={height} stroke="var(--color-muted-foreground)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        ) : null}
      </svg>
      {hv !== null ? (
        <div
          aria-hidden
          className="bg-popover text-popover-foreground pointer-events-none absolute -top-1 z-10 rounded-md border px-2 py-1 font-mono text-[11px] whitespace-nowrap shadow-sm"
          style={{ left: `${x}%`, transform: `translate(${x > 70 ? '-100%' : x < 30 ? '0' : '-50%'}, -100%)` }}
        >
          <span className="text-muted-foreground">{clock(slotStart(grid, hv))} · </span>
          {v !== null && v !== undefined ? `${format(v)} ${noun}` : 'not measured'}
        </div>
      ) : null}
    </div>
  );
}
