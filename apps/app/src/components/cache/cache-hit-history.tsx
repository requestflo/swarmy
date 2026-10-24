import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Tech } from '@/components/calm';
import { HistoryChart } from '@/components/history/history-chart';
import { known, lastKnown } from '@/components/history/history-model';
import { TextSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import type { CacheView } from './cache-words';

const compact = new Intl.NumberFormat('en-GB', { notation: 'compact', maximumFractionDigits: 1 });
const pct = (n: number): string => `${Math.round(n)}%`;

/**
 * "Hit rate · 24 h" (board 41): the share of each 15 minutes' lookups that
 * found their key, from `cache.statsHistory`. Gaps stay gaps; nothing draws
 * until two readings have landed (a hit rate is a difference of two).
 */
export function CacheHitHistory({ v }: { v: CacheView }): React.JSX.Element {
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.cache.statsHistory.queryOptions({ stack: v.stack, cluster: v.name }), refetchInterval: 60_000 });
  if (q.isPending) return <TextSkeleton className="h-14 w-full" />;
  if (q.isError) return <p className="text-muted-foreground text-[12.5px]">Couldn’t load the last 24 hours just now.</p>;
  const h = q.data;
  const rates = known(h.hitRatePct);
  if (rates.length === 0) {
    return <p className="text-muted-foreground text-[12.5px]">No history yet. swarmy keeps a reading every 5 minutes; the 24-hour chart starts with the second one.</p>;
  }
  const ops = lastKnown(h.opsPerSec) ?? v.stats?.opsPerSec ?? null;
  const lowest = Math.min(...rates);
  // A hit rate lives near the top: the scale starts 10 points under the day's lowest, so a dip shows.
  const floor = Math.max(0, Math.floor((lowest - 10) / 10) * 10);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="calm-eyebrow">Hit rate · 24 h</span>
        <span className="text-muted-foreground font-mono text-[11.5px]">
          lowest {pct(lowest)}
          {ops !== null ? ` · ${compact.format(ops).toLowerCase()} ops/s` : ''}
        </span>
      </div>
      <HistoryChart grid={h} values={h.hitRatePct} noun="hit rate" format={pct} min={floor} max={100} area={floor === 0} />
      <span className="text-muted-foreground -mt-1 flex justify-between font-mono text-[10.5px]" aria-hidden>
        <span>24 h ago · scale {floor}–100%</span>
        <span>now</span>
      </span>
      <Tech>cache.statsHistory · keyspace hits ÷ lookups per 15 minutes, from the 5-minute INFO samples · telemetry.db</Tech>
    </div>
  );
}
