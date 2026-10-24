import * as React from 'react';
import { cn } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { compact, pct } from './rum-shared';
import type { FunnelView } from './funnel-model';

interface FunnelChartProps {
  view: FunnelView;
}

/**
 * The funnel as ranked bars: how many reached each step, what it's called,
 * and the share lost since the step before. Bars scale to the first step; the
 * biggest drop's share reads in amber, so it is never colour alone.
 */
export function FunnelChart({ view }: FunnelChartProps): React.JSX.Element {
  const first = Math.max(1, view.steps[0]?.visitors ?? 0);
  const worst = view.biggestDrop?.index ?? -1;
  return (
    <ol className="flex flex-col gap-1" aria-label="Funnel steps">
      {view.steps.map((s, i) => (
        <li key={`${i}-${s.path}`} className="grid grid-cols-[4.5rem_minmax(0,1fr)_3.5rem] items-center gap-3">
          <span className="text-right font-mono text-[15px] font-semibold">{compact(s.visitors)}</span>
          <span className="relative flex min-h-9 min-w-0 flex-col justify-center py-1">
            <i
              aria-hidden
              className={cn('absolute inset-y-0.5 left-0 rounded-md', i === worst ? 'bg-status-warning/20' : 'bg-status-progress/12')}
              style={{ width: `${Math.max(2, (s.visitors / first) * 100)}%` }}
            />
            <span className="relative truncate pl-2 text-sm font-semibold">{s.name}</span>
            <Tech className="relative truncate pl-2">
              {s.event ? `event ${s.event} on ${s.path}` : s.path}
            </Tech>
          </span>
          <span className={cn('text-right font-mono text-xs', i === worst ? 'text-tone-warn font-semibold' : 'text-muted-foreground')}>
            {i === 0 ? '' : `−${pct(s.dropOff)}`}
          </span>
        </li>
      ))}
    </ol>
  );
}
