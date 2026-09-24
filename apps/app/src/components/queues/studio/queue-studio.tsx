import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeftIcon, ListOrderedIcon, RefreshCwIcon } from 'lucide-react';
import { Button, EmptyState, StatusBadge, cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CountUp } from '@/components/count-up';
import { CardSkeleton, ErrorState } from '@/components/states';
import { QueueDetail } from './queue-detail';
import type { StudioQueue, StudioRef } from './studio-types';

/**
 * Queue studio: every BullMQ queue on one managed cache, found by key
 * pattern and read through the agent (the cache stays private). It's
 * master-detail. On the left is the queue list with live counts; on the
 * right are the selected queue's state tabs, jobs, actions and rates.
 */
export function QueueStudio({ stack, cluster }: { stack: string; cluster: string }): React.JSX.Element {
  const trpc = useTRPC();
  const ref: StudioRef = { stack, cluster, prefix: 'bull' };
  const [selected, setSelected] = React.useState<string | null>(null);

  const overview = useQuery({
    ...trpc.queues.studioOverview.queryOptions(ref),
    refetchInterval: 5_000,
    retry: false,
  });
  const queues = (overview.data?.queues ?? []) as StudioQueue[];
  const current = queues.find((q) => q.name === selected) ?? queues[0] ?? null;
  const totals = queues.reduce(
    (t, q) => ({ backlog: t.backlog + q.backlog, active: t.active + q.counts.active, failed: t.failed + q.counts.failed }),
    { backlog: 0, active: 0, failed: 0 },
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/stacks/$name/messaging" params={{ name: stack }}>
            <ArrowLeftIcon className="size-4" /> Messaging
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="font-display truncate text-2xl font-bold sm:text-3xl">
            Queue studio <span className="text-muted-foreground mono-data text-lg">{cluster}</span>
          </h1>
          <p className="text-muted-foreground text-sm">
            BullMQ on {stack}/{cluster} · read through the agent, never exposed
            {overview.data?.purpose === 'cache' ? ' · this cache evicts — use a queue cache for BullMQ' : ''}
          </p>
        </div>
        {overview.data ? (
          <StatusBadge
            tone={totals.failed > 0 ? 'warning' : 'online'}
            label={totals.failed > 0 ? `${totals.failed.toLocaleString()} failed` : 'healthy'}
          />
        ) : null}
        <Button variant="outline" size="sm" disabled={overview.isFetching} onClick={() => void overview.refetch()}>
          <RefreshCwIcon className={cn('size-3.5', overview.isFetching && 'animate-spin')} /> Refresh
        </Button>
      </div>

      {overview.isLoading ? (
        <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
          <CardSkeleton lines={4} />
          <CardSkeleton lines={8} />
        </div>
      ) : overview.isError ? (
        <ErrorState title="Couldn’t read this cache." error={overview.error} retry={() => void overview.refetch()} />
      ) : queues.length === 0 ? (
        <EmptyState
          icon={<ListOrderedIcon />}
          title="No BullMQ queues here yet — add a job."
          description={`Point BullMQ at QUEUE_URL (this cluster) and add a job: queues show up as soon as ${'`bull:<queue>:meta`'} exists.`}
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
          <aside className="card-pop h-fit space-y-3 p-4">
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  ['Backlog', totals.backlog],
                  ['Active', totals.active],
                  ['Failed', totals.failed],
                ] as const
              ).map(([label, v]) => (
                <div key={label}>
                  <p className="mono-label text-muted-foreground !mb-0 !text-[10px]">{label}</p>
                  <p className={cn('mono-data text-lg', label === 'Failed' && v > 0 && 'text-status-offline')}>
                    <CountUp value={v} />
                  </p>
                </div>
              ))}
            </div>
            <div className="divide-border divide-y">
              {queues.map((q) => {
                const active = current?.name === q.name;
                return (
                  <button
                    key={q.name}
                    type="button"
                    onClick={() => setSelected(q.name)}
                    className={cn(
                      'hover:bg-muted/30 -mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-md border-l-[3px] border-transparent px-2 py-2.5 text-left',
                      active && 'bg-accent border-primary',
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="mono-data truncate text-sm font-semibold">{q.name}</p>
                      <p className="text-muted-foreground text-[11px]">
                        {q.backlog.toLocaleString()} waiting · {q.counts.active} active
                        {q.rate ? ` · ${q.rate.throughput}/min` : ''}
                      </p>
                    </div>
                    {q.isPaused ? (
                      <StatusBadge tone="neutral" label="paused" />
                    ) : q.counts.failed > 0 ? (
                      <StatusBadge tone="warning" label={`${q.counts.failed} failed`} />
                    ) : null}
                  </button>
                );
              })}
            </div>
            {overview.data?.truncated ? (
              <p className="text-muted-foreground text-[11px]">
                Large keyspace — showing the first {queues.length} queues found.
              </p>
            ) : null}
          </aside>
          {current ? <QueueDetail key={current.name} studio={ref} queue={current} /> : null}
        </div>
      )}
    </div>
  );
}
