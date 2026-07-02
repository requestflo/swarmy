import * as React from 'react';
import type { UptimeDayView } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { uptimeBarClass } from './status-tone';

/**
 * The 90-day uptime strip: one tiny bar per day, oldest → newest. Green =
 * clean day, amber = wobbly, red = a bad day, muted = no samples. Native
 * `title` tooltips keep the public page dependency-free and mobile-fine.
 */
export function UptimeBars({
  days,
  className,
}: {
  days: UptimeDayView[];
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn('flex h-8 items-stretch gap-px', className)} aria-hidden={false}>
      {days.map((d) => (
        <div
          key={d.day}
          title={d.pct === null ? `${d.day} — no data` : `${d.day} — ${d.pct}%`}
          className={cn('min-w-0 flex-1 rounded-[2px]', uptimeBarClass(d.pct))}
        />
      ))}
    </div>
  );
}
