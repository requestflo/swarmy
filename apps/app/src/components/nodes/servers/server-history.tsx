import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { TextSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { historyRows, pctPath, type HistoryRow } from './server-history-model';

const W = 288;
const H = 24;

function Spark({ row }: { row: HistoryRow }): React.JSX.Element {
  const d = pctPath(row.values, W, H);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${row.label} over the last 24 hours, peak ${Math.round(row.peak)}%`}
      className={cn('block h-6 w-full overflow-visible', row.hot ? 'text-tone-warn' : 'text-muted-foreground')}
    >
      <line x1={0} x2={W} y1={H - 1} y2={H - 1} stroke="currentColor" strokeWidth={1} opacity={0.18} vectorEffect="non-scaling-stroke" />
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * "Last 24 hours" in the inspector (board 11): CPU, memory and disk as
 * sparklines of 5-minute peaks (`nodes.statsHistory`), each with its highest
 * reading. Gaps stay gaps; nothing shows until the history has answered.
 */
export function ServerHistory({ nodeId }: { nodeId: string }): React.JSX.Element {
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.nodes.statsHistory.queryOptions({ nodeId }), refetchInterval: 60_000 });
  const server = q.data?.servers.find((s) => s.nodeId === nodeId);
  const rows = server ? historyRows(server) : [];
  return (
    <div className="flex flex-col gap-2">
      <h3 className="calm-eyebrow">Last 24 hours</h3>
      {q.isPending ? (
        <div className="grid gap-2.5">
          <TextSkeleton className="h-4 w-full" />
          <TextSkeleton className="h-4 w-4/5" />
        </div>
      ) : q.isError ? (
        <p className="text-muted-foreground text-[13px]">Couldn’t load the last 24 hours just now.</p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-[13px]">No history yet. swarmy keeps a reading every minute once the server reports.</p>
      ) : (
        <ul aria-label="The last 24 hours" className="grid gap-2.5">
          {rows.map((r) => (
            <li key={r.key} className="grid grid-cols-[4.5rem_minmax(0,1fr)_5.5rem] items-center gap-3 text-[13px]">
              <span className="text-muted-foreground">{r.label}</span>
              <Spark row={r} />
              <span className={cn('text-right font-mono text-[12px]', r.hot ? 'text-tone-warn' : 'text-foreground')}>
                <span className="text-muted-foreground">peak </span>
                {Math.round(r.peak)}%
              </span>
            </li>
          ))}
        </ul>
      )}
      {rows.length > 0 ? <Tech>nodes.statsHistory · 5-minute peaks of the per-minute samples · telemetry.db</Tech> : null}
    </div>
  );
}
