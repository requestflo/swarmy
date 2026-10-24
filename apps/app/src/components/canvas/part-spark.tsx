import * as React from 'react';
import { cn } from '@swarmy/ui';
import { sparkPath } from '@/components/apps/app-board-words';

const W = 220;
const H = 18;

/**
 * A part's last hour of requests on its canvas node: a quiet line, amber when
 * the part needs you. A part that has not reported yet draws nothing (the
 * series starts where its spans do), never a flat zero.
 */
export function PartSpark({ name, values, warn }: { name: string; values: (number | null)[]; warn: boolean }): React.JSX.Element | null {
  const d = sparkPath(values, W, H);
  if (!d) return null;
  const known = values.filter((v): v is number => v !== null);
  const peak = Math.max(...known);
  const label = `${name}: requests over the last hour, peak ${peak} per 2 minutes`;
  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={label}
      className={cn('mt-2 block max-w-full overflow-visible', warn ? 'text-tone-warn' : 'text-muted-foreground')}
    >
      <title>{label}</title>
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" opacity={0.8} />
    </svg>
  );
}
