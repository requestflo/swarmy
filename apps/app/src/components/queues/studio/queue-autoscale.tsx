import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { autoscaleLine, calmLine, workerCooldown } from './autoscale-words';
import type { StudioRef } from './studio-types';

/**
 * The autoscale rule of every worker that consumes this queue (any stack),
 * with how many run now and, while its calm clock runs, when they drop.
 */
export function QueueAutoscale({ studio, queue }: { studio: StudioRef; queue: string }): React.JSX.Element | null {
  const trpc = useTRPC();
  const list = useQuery({ ...trpc.queues.list.queryOptions(), refetchInterval: 15_000 });
  const all = list.data ?? [];
  const defs = all.filter(
    (q) => q.name === queue && q.convention === 'bullmq' && q.cacheStack === studio.stack && q.cacheName === studio.cluster,
  );
  if (defs.length === 0) return null;
  const now = Date.now();
  return (
    <div className="grid gap-1">
      {defs.map((q) => {
        const calm = calmLine(q, workerCooldown(all, q.workerService), now);
        return (
          <p key={q.workerService} className="text-muted-foreground text-sm">
            {autoscaleLine(q)} {q.workers.running} running now.{calm ? ` ${calm}` : ''}{' '}
            <Link to="/stacks/$name/config/scaling" params={{ name: q.stack }} className="text-foreground underline-offset-2 hover:underline">
              Scaling
            </Link>
          </p>
        );
      })}
    </div>
  );
}
