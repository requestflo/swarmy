import * as React from 'react';
import { cn } from '@swarmy/ui';
import type { Busy } from './server-words';

const R = 14;
const C = 2 * Math.PI * R;

/** How busy a server is: a ring filled to the busier of CPU and memory. Dashed while there's no live number. */
export function RingGauge({ busy }: { busy: Busy | null }): React.JSX.Element {
  const hot = busy !== null && busy.pct >= 85;
  const label = busy ? `${busy.pct}% ${busy.which} in use` : 'No live numbers';
  return (
    <svg width={36} height={36} viewBox="0 0 36 36" role="img" aria-label={label} className="shrink-0">
      <title>{label}</title>
      <circle cx={18} cy={18} r={R} fill="none" stroke="currentColor" strokeWidth={3} className="text-foreground/10" strokeDasharray={busy ? undefined : '3 4'} />
      {busy ? (
        <circle
          cx={18}
          cy={18}
          r={R}
          fill="none"
          strokeWidth={3}
          strokeLinecap="round"
          stroke="currentColor"
          className={cn(hot ? 'text-status-warning' : 'text-status-online')}
          strokeDasharray={`${(Math.max(2, busy.pct) / 100) * C} ${C}`}
          transform="rotate(-90 18 18)"
        />
      ) : null}
    </svg>
  );
}
