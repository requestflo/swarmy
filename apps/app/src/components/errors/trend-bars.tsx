import * as React from 'react';
import { cn } from '@swarmy/ui';

/** 24 hourly bars — the issue's last day at a glance. */
export function TrendBars({ data, className }: { data: number[]; className?: string }): React.JSX.Element {
  const max = Math.max(1, ...data);
  return (
    <svg viewBox="0 0 48 16" className={cn('h-4 w-12', className)} aria-hidden>
      {data.map((v, i) => {
        const h = v === 0 ? 0.75 : Math.max(2, (v / max) * 16);
        return <rect key={i} x={i * 2} y={16 - h} width={1.4} height={h} className={v ? 'fill-status-offline/70' : 'fill-muted-foreground/25'} />;
      })}
    </svg>
  );
}
