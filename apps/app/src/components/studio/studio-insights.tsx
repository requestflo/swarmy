import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { GaugeIcon, LightbulbIcon } from 'lucide-react';
import { useTRPC } from '@/integrations/trpc';
import { CardSkeleton, ErrorState } from '@/components/states';
import type { StudioScope } from './studio-types';

const SOURCE: Record<string, string> = {
  pg_stat_statements: 'From pg_stat_statements on the primary · slowest by total time.',
  performance_schema: 'From performance_schema statement digests · slowest by total time.',
  slow_log: 'From the slow query log (mysql.slow_log).',
  profiler: 'From the database profiler (system.profile) · slowest recent operations.',
  slowlog: 'From SLOWLOG · the server’s own record of slow commands.',
};

const ms = (v: number | null) => (v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`);

/** Slow-query insights; degrades to the reason + how to turn a source on. */
export function StudioInsights({ scope, onOpen }: { scope: StudioScope; onOpen: (statement: string) => void }): React.JSX.Element {
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.studio.insights.queryOptions({ stack: scope.stack, target: scope.target.name, database: scope.database }), refetchInterval: 30_000 });
  if (q.isPending) return <CardSkeleton />;
  if (q.isError) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const d = q.data;
  return (
    <div className="space-y-4">
      {d.unavailable ? (
        <div className="card-pop flex gap-3 border-0 p-4">
          <LightbulbIcon className="text-status-warning mt-0.5 size-5 shrink-0" />
          <div className="space-y-1 text-sm">
            <p className="font-semibold">No slow-query source: {d.unavailable.reason}.</p>
            <p className="text-muted-foreground">{d.unavailable.hint}</p>
          </div>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">{d.source ? SOURCE[d.source] : null}</p>
      )}
      {d.slow.length > 0 ? (
        <div className="card-pop overflow-hidden border-0">
          <div className="bg-muted grid grid-cols-[1fr_5rem_5rem_5rem] gap-3 px-3 py-2 text-xs font-semibold">
            <span>statement</span>
            <span>mean</span>
            <span>total</span>
            <span>calls</span>
          </div>
          {d.slow.map((s, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onOpen(s.query)}
              title="Open in the console"
              className="hover:bg-accent/60 border-border grid w-full grid-cols-[1fr_5rem_5rem_5rem] gap-3 border-t px-3 py-2 text-left font-mono text-xs"
            >
              <span className="truncate">{s.query}</span>
              <span className={(s.meanMs ?? 0) > 150 ? 'text-status-warning font-semibold' : ''}>{ms(s.meanMs)}</span>
              <span>{ms(s.totalMs)}</span>
              <span>{s.calls ?? '—'}</span>
            </button>
          ))}
        </div>
      ) : !d.unavailable ? (
        <p className="text-muted-foreground text-sm">Nothing slow recorded yet.</p>
      ) : null}
      {d.active.length > 0 ? (
        <div className="card-pop overflow-hidden border-0">
          <div className="border-border flex items-center gap-2 border-b px-3 py-2">
            <GaugeIcon className="text-muted-foreground size-3.5" />
            <span className="mono-label text-muted-foreground">Running now</span>
          </div>
          {d.active.map((a) => (
            <div key={a.pid} className="border-border flex items-center gap-3 border-b px-3 py-2 font-mono text-xs">
              <span className="text-muted-foreground w-16 shrink-0">{a.pid}</span>
              <span className="w-20 shrink-0 truncate">{a.state ?? ''}</span>
              <span className="min-w-0 flex-1 truncate">{a.query}</span>
              <span className="shrink-0">{a.seconds != null ? `${a.seconds} s` : ''}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
