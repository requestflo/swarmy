import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Tech } from '@/components/calm';
import { HistoryChart } from '@/components/history/history-chart';
import { known } from '@/components/history/history-model';
import { TextSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import type { StudioRef } from './studio-types';

const n = (v: number): string => Math.round(v).toLocaleString();

/**
 * "<queue> depth vs workers · 6 h" (board 64), from `queues.depthHistory`:
 * the deepest backlog and the most worker copies in each 5 minutes. Two
 * small charts on one time axis (one scale each), sharing a crosshair, so
 * you can see the copies follow the depth.
 */
export function QueueDepthHistory({ studio, queue }: { studio: StudioRef; queue: string }): React.JSX.Element {
  const trpc = useTRPC();
  const [hover, setHover] = React.useState<number | null>(null);
  const q = useQuery({
    ...trpc.queues.depthHistory.queryOptions({ stack: studio.stack, cluster: studio.cluster, prefix: studio.prefix, queue }),
    refetchInterval: 60_000,
    retry: false,
  });
  if (q.isPending) return <TextSkeleton className="h-20 w-full" />;
  if (q.isError) return <p className="text-muted-foreground text-[11px]">Couldn’t load the last 6 hours just now.</p>;
  const h = q.data;
  const depth = known(h.waiting);
  if (depth.length === 0) {
    return <p className="text-muted-foreground text-[11px]">Depth history starts with the next 5-minute sample. swarmy keeps 7 days of it.</p>;
  }
  const copies = known(h.workers);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="mono-label text-muted-foreground !mb-0">{queue} depth vs workers · 6 h</p>
        <span className="text-muted-foreground font-mono text-[11px]">
          peak {n(Math.max(...depth))} waiting
          {copies.length ? ` · ${Math.min(...copies)}–${Math.max(...copies)} copies` : ''}
        </span>
      </div>
      <div>
        <p className="text-muted-foreground text-[11px]">Waiting</p>
        <HistoryChart grid={h} values={h.waiting} noun="waiting" format={n} area height={64} hover={hover} onHover={setHover} />
      </div>
      {copies.length ? (
        <div>
          <p className="text-muted-foreground text-[11px]">Worker copies</p>
          <HistoryChart
            grid={h}
            values={h.workers}
            noun={Math.max(...copies) === 1 ? 'copy' : 'copies'}
            format={n}
            step
            max={Math.max(1, ...copies) * 1.25}
            height={28}
            hover={hover}
            onHover={setHover}
          />
        </div>
      ) : (
        <p className="text-muted-foreground text-[11px]">No worker definition takes jobs from this queue, so there are no copies to chart.</p>
      )}
      <Tech>queues.depthHistory · deepest backlog (waiting + paused + prioritized) and most worker copies per 5 minutes · telemetry.db</Tech>
    </div>
  );
}
