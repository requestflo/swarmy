import * as React from 'react';
import { fmtBytes } from '@/components/backups/backup-format';
import { clockLabel, momentLabel } from './time-travel-model';
import { sizeAt, sizePath, type SizeSeries } from './time-travel-sizes';
import { HeadLine } from './travel-lane';

const H = 44;

/** What the number is, said once in the lane's label: a dump is smaller than the database it saves. */
export function sizeMeasureWords(s: SizeSeries): string {
  return s.measure === 'data' ? `${s.cluster}’s data, as each base backup copied it` : `${s.cluster}’s saves (a compressed dump is smaller than the database)`;
}

/**
 * The database's size across the week (board 10's scrubber): a step line
 * through each recorded size, and the size at the head, the newest one
 * recorded at or before it.
 */
export function TravelSizeLane({ series, at, pos, live }: { series: SizeSeries; at: number; pos: number; live: boolean }): React.JSX.Element {
  const here = sizeAt(series, at);
  const label = here
    ? `${fmtBytes(here.bytes)}${live ? '' : ` · ${clockLabel(here.at)}`}`
    : 'before the first save';
  const right = pos < 0.8;
  return (
    <div
      className="relative h-11"
      role="img"
      aria-label={`${sizeMeasureWords(series)}: ${here ? `${fmtBytes(here.bytes)} at the save of ${momentLabel(here.at)}` : 'no size recorded this early'}`}
    >
      <span aria-hidden className="bg-border absolute top-1/2 right-0 left-0 h-px" />
      <svg aria-hidden viewBox={`0 0 1000 ${H}`} preserveAspectRatio="none" className="text-tone-info absolute inset-0 h-full w-full">
        <polyline points={sizePath(series, H)} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" opacity={0.75} />
      </svg>
      <HeadLine pos={pos} />
      <span
        aria-hidden
        className="bg-card/90 text-foreground absolute top-0.5 rounded px-1 font-mono text-[11px] whitespace-nowrap"
        style={right ? { left: `calc(${(pos * 100).toFixed(3)}% + 6px)` } : { right: `calc(${((1 - pos) * 100).toFixed(3)}% + 6px)` }}
      >
        {label}
      </span>
    </div>
  );
}
