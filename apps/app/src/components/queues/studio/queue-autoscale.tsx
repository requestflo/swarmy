import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { QueueView } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import type { StudioRef } from './studio-types';

/** "Autoscale: email-worker 1 → 4 copies, one per 25 waiting jobs." — from the worker's `swarmy.queues` def. */
export function autoscaleLine(q: QueueView): string {
  const svc = q.workerService.startsWith(`${q.stack}_`) ? q.workerService.slice(q.stack.length + 1) : q.workerService;
  if (q.maxWorkers <= q.minWorkers) return `Workers: ${svc} stays at ${q.minWorkers} ${q.minWorkers === 1 ? 'copy' : 'copies'}.`;
  return `Autoscale: ${svc} ${q.minWorkers} → ${q.maxWorkers} copies, one per ${q.scalePerJobs.toLocaleString()} waiting jobs.`;
}

/** The autoscale rule of every worker that consumes this queue (any stack), with how many run now. */
export function QueueAutoscale({ studio, queue }: { studio: StudioRef; queue: string }): React.JSX.Element | null {
  const trpc = useTRPC();
  const list = useQuery({ ...trpc.queues.list.queryOptions(), refetchInterval: 15_000 });
  const defs = (list.data ?? []).filter(
    (q) => q.name === queue && q.convention === 'bullmq' && q.cacheStack === studio.stack && q.cacheName === studio.cluster,
  );
  if (defs.length === 0) return null;
  return (
    <div className="grid gap-1">
      {defs.map((q) => (
        <p key={q.workerService} className="text-muted-foreground text-sm">
          {autoscaleLine(q)} {q.workers.running} running now.{' '}
          <Link to="/stacks/$name/config/scaling" params={{ name: q.stack }} className="text-foreground underline-offset-2 hover:underline">
            Scaling
          </Link>
        </p>
      ))}
    </div>
  );
}
