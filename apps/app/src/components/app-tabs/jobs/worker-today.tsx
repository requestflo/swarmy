import * as React from 'react';
import { useQueries } from '@tanstack/react-query';
import type { QueueDepthHistoryView, QueueView } from '@swarmy/core';
import { HistoryChart } from '@/components/history/history-chart';
import { TextSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { localMidnight, workerToday } from './worker-today-model';

const n = (v: number): string => Math.round(v).toLocaleString();

/**
 * "today 1,284" on a worker's row (board AppJobs), plus a sparkline of the
 * jobs it finished per 15 minutes over the last 24 hours, every one of its
 * BullMQ queues added up (`queues.depthHistory`). Nothing for a worker with
 * no BullMQ queue: a raw list doesn't say when a job is done.
 */
export function WorkerToday({ queues }: { queues: QueueView[] }): React.JSX.Element | null {
  const trpc = useTRPC();
  const bull = queues.filter((q) => q.convention === 'bullmq');
  const hist = useQueries({
    queries: bull.map((q) => ({
      ...trpc.queues.depthHistory.queryOptions({ stack: q.cacheStack, cluster: q.cacheName, queue: q.name, hours: 24 }),
      refetchInterval: 60_000,
      retry: false,
    })),
  });
  if (bull.length === 0) return null;
  if (hist.some((h) => h.isPending)) return <TextSkeleton className="h-4 w-20 shrink-0" />;
  const views = hist.map((h) => h.data).filter((v): v is QueueDepthHistoryView => Boolean(v));
  const t = workerToday(views, localMidnight(new Date()));
  return (
    <span className="flex shrink-0 items-center gap-2">
      {t.grid && t.done.some((v) => v !== null) ? (
        <span className="hidden w-20 sm:block">
          <HistoryChart grid={t.grid} values={t.done} noun="jobs done" format={n} height={20} />
        </span>
      ) : null}
      <span className="font-mono text-[12px] whitespace-nowrap">
        <span className="text-muted-foreground">today </span>
        {t.today !== null ? n(t.today) : <span className="text-muted-foreground">not measured yet</span>}
      </span>
    </span>
  );
}
