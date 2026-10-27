import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { DAY_NAMES, ROW_DAYS, heatGrid, quietestSlot, type PatchWindow } from './traffic-heatmap-model';

const HOURS = ['00', '02', '04', '06', '08', '10', '12', '14', '16', '18', '20', '22'];

/**
 * The last four weeks of traffic at the edge by day and two-hour slot (UTC),
 * each slot the average of its four days, with the auto-patch window drawn on
 * top — so the window can sit in your quiet hours. `traffic.series` 28d reads
 * the hourly rollups (kept 35 days). Nothing renders until an edge has reported.
 */
export function TrafficHeatmap({ window: w }: { window: PatchWindow }): React.JSX.Element | null {
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.traffic.series.queryOptions({ window: '28d' }), staleTime: 5 * 60_000 });
  const grid = React.useMemo(() => (q.data ? heatGrid(q.data.points, w) : null), [q.data, w]);
  if (!grid || grid.every((row) => row.every((c) => c.rate == null))) return null;
  const quiet = quietestSlot(grid);

  return (
    <figure className="grid gap-1" aria-label="Edge traffic by hour, last 4 weeks, with the patch window">
      <div className="grid grid-cols-[34px_repeat(12,minmax(0,1fr))] gap-[3px]">
        <span />
        {HOURS.map((h) => (
          <span key={h} className="text-muted-foreground font-mono text-[10px]">
            {h}
          </span>
        ))}
        {grid.map((cells, r) => (
          <React.Fragment key={ROW_DAYS[r]}>
            <span className="text-muted-foreground font-mono text-[10px] leading-[15px]">{DAY_NAMES[ROW_DAYS[r]!]}</span>
            {cells.map((c, i) => (
              <i
                key={i}
                title={`${DAY_NAMES[ROW_DAYS[r]!]} ${HOURS[i]}:00 UTC · ${c.rate == null ? 'no data' : `${Math.round(c.rate)} req/min`}${c.inWindow ? ' · patch window' : ''}`}
                className={cn('block h-[15px] rounded-[3px]', c.inWindow ? 'bg-primary ring-primary/30 ring-2' : c.level == null && 'bg-muted')}
                style={
                  c.inWindow || c.level == null
                    ? undefined
                    : { backgroundColor: `color-mix(in oklch, var(--status-progress) ${Math.round(8 + c.level * 62)}%, transparent)` }
                }
              />
            ))}
          </React.Fragment>
        ))}
      </div>
      <figcaption className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 pt-1 font-mono text-[10.5px]">
        <span className="flex items-center gap-1.5">
          <i className="bg-status-progress/55 inline-block size-2.5 rounded-[3px]" /> traffic at the edge (last 4 weeks)
        </span>
        <span className="flex items-center gap-1.5">
          <i className="bg-primary inline-block size-2.5 rounded-[3px]" /> patch window
        </span>
        {quiet ? <span>quietest: {quiet}</span> : null}
      </figcaption>
    </figure>
  );
}
