import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { CopyButton } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { CardSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import type { StudioScope } from './studio-types';

const fmtMs = (v: number | null): string => (v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`);
const fmtCalls = (n: number) => n.toLocaleString('en-US');

/**
 * The last 24 hours of a managed Postgres's statements (`studio.slowQueries`):
 * mean, an estimated p95 and calls per 24 h from swarmy's 5-minute
 * pg_stat_statements snapshots, each with Copy SQL. Renders nothing until the
 * first two snapshots exist, so the cumulative list below stays the answer.
 */
export function StudioSlow24h({ scope, onOpen }: { scope: StudioScope; onOpen: (statement: string) => void }): React.JSX.Element | null {
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.studio.slowQueries.queryOptions({ stack: scope.stack, target: scope.target.name }), refetchInterval: 60_000 });
  if (q.isPending) return <CardSkeleton />;
  if (q.isError || q.data.rows.length === 0) {
    return q.isError ? null : (
      <p className="text-muted-foreground text-sm">The last-24-hours view fills in as swarmy reads pg_stat_statements every {q.data.everyMinutes} minutes.</p>
    );
  }
  const d = q.data;
  const cols = 'sm:grid-cols-[minmax(0,1fr)_4.5rem_4.5rem_5.5rem_7rem]';
  return (
    <section aria-label="Slow queries, last 24 hours" className="space-y-2">
      <p className="text-sm">
        <span className="font-semibold">Last {d.windowHours} hours</span>
        <span className="text-muted-foreground"> · slowest by total time · sampled every {d.everyMinutes} minutes</span>
      </p>
      <div className="calm-card shadow-none overflow-hidden border-0">
        <div className={`bg-muted hidden gap-3 px-3 py-2 text-xs font-semibold sm:grid ${cols}`}>
          <span>statement</span>
          <span>mean</span>
          <span title={d.p95Note}>p95 (est.)</span>
          <span>calls / 24 h</span>
          <span className="sr-only">copy</span>
        </div>
        {d.rows.map((s) => (
          <div key={s.queryId} className={`border-border grid grid-cols-3 items-center gap-x-3 gap-y-1 border-t px-3 py-2 font-mono text-xs ${cols}`}>
            <button type="button" onClick={() => onOpen(s.query)} title="Open in the console" className="hover:text-primary col-span-3 min-h-11 truncate text-left sm:col-span-1 sm:min-h-0">
              {s.query || `queryid ${s.queryId}`}
            </button>
            <span className={(s.meanMs ?? 0) > 150 ? 'text-tone-warn font-semibold whitespace-nowrap' : 'whitespace-nowrap'}>
              <span className="text-muted-foreground sm:hidden">mean </span>{fmtMs(s.meanMs)}
            </span>
            <span className="whitespace-nowrap"><span className="text-muted-foreground sm:hidden">p95 ~</span>{fmtMs(s.p95Ms)}</span>
            <span className="whitespace-nowrap"><span className="text-muted-foreground sm:hidden">calls </span>{fmtCalls(s.calls)}</span>
            <CopyButton value={s.query} label="Copy SQL" className="col-span-3 justify-self-start font-sans pointer-coarse:min-h-11 sm:col-span-1 sm:justify-self-end" />
          </div>
        ))}
      </div>
      <p className="text-muted-foreground text-xs">{d.p95Note}</p>
      <Tech>studio.slowQueries · pg_stat_statements deltas every {d.everyMinutes} min → telemetry.db · since {d.since ?? '—'}</Tech>
    </section>
  );
}
