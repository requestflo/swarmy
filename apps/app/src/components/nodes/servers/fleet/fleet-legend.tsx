import * as React from 'react';
import { cn } from '@swarmy/ui';

/** What the rings and lines mean (board 11's legend), in Summary words. */
export function FleetLegend({ meshOn, className }: { meshOn: boolean; className?: string }): React.JSX.Element {
  const ring = (label: string, opacity: number) => (
    <li className="flex items-center gap-1.5">
      <span aria-hidden className="bg-status-online h-[3px] w-[18px] rounded-sm" style={{ opacity }} />
      {label}
    </li>
  );
  return (
    <ul
      aria-label="Legend"
      className={cn('bg-card/85 border-border text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border px-3 py-2 font-mono text-[12px]', className)}
    >
      {ring('outer · CPU, the number', 1)}
      {ring('middle · memory', 0.85)}
      {ring('inner · disk', 0.7)}
      {meshOn ? (
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="border-tone-mesh w-[18px] border-t-2 border-dashed" />
          private network link
        </li>
      ) : null}
    </ul>
  );
}
