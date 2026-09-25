import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDownIcon, ListOrderedIcon } from 'lucide-react';
import type { QueueView } from '@swarmy/core';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  cn,
  type StatusTone,
} from '@swarmy/ui';
import { StatusWord, toneFromStatus } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { CountUp } from '@/components/count-up';
import { QueueActions } from './queue-actions';
import { QueueDlqPanel } from './queue-dlq-panel';
import { QueueRulesEditor } from './queue-rules-editor';

/** Health tone for one queue row (failed > backlog > worker health). */
export function queueTone(q: QueueView): { tone: StatusTone; label: string } {
  if (!q.cacheOnline) return { tone: 'offline', label: 'Cache offline' };
  if ((q.stats?.failed ?? 0) > 0) return { tone: 'warning', label: `${q.stats?.failed} failed` };
  if (q.workers.running < Math.min(q.workers.desired, q.minWorkers)) {
    return { tone: 'progress', label: 'Scaling' };
  }
  return { tone: 'online', label: 'Healthy' };
}

/**
 * One queue as a flat row (hairlines from the parent list). Expands inline —
 * never a Sheet — to live depths, the scale-rule editor, actions and the DLQ.
 */
export function QueueRow({ queue }: { queue: QueueView }): React.JSX.Element {
  const trpc = useTRPC();
  const [open, setOpen] = React.useState(false);
  const tone = queueTone(queue);

  const live = useQuery({
    ...trpc.queues.stats.queryOptions({ workerService: queue.workerService, queue: queue.name }),
    enabled: open,
    refetchInterval: 3_000,
    retry: false,
  });
  const stats = live.data ?? queue.stats ?? null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="hover:bg-foreground/[0.025] flex min-h-14 w-full items-center gap-3 rounded-sm px-1 py-2.5 text-left"
          aria-label={`${open ? 'Collapse' : 'Expand'} queue ${queue.name}`}
        >
          <span aria-hidden className="bg-foreground/[0.05] text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-lg">
            <ListOrderedIcon className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="mono-data truncate font-semibold">{queue.name}</p>
            <p className="text-muted-foreground truncate text-xs">
              {queue.workerService} · {queue.convention === 'bullmq' ? 'BullMQ' : 'raw list'}
            </p>
          </div>
          <div className="hidden shrink-0 gap-5 text-right md:flex">
            <div>
              <p className="mono-label text-muted-foreground !mb-0 !text-[10px]">Waiting</p>
              <p className="mono-data text-sm">{queue.stats?.wait ?? '—'}</p>
            </div>
            <div>
              <p className="mono-label text-muted-foreground !mb-0 !text-[10px]">Workers</p>
              <p className="mono-data text-sm">
                {queue.workers.running}/{queue.maxWorkers}
              </p>
            </div>
          </div>
          <StatusWord tone={toneFromStatus(tone.tone as 'online')} word={tone.label} className="shrink-0" />
          <ChevronDownIcon
            className={cn('text-muted-foreground size-4 shrink-0 transition-transform', open && 'rotate-180')}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-border bg-muted/10 mb-2 space-y-5 rounded-lg border p-4">
          <section className="grid grid-cols-4 gap-2">
            {(
              [
                ['Waiting', stats?.wait],
                ['Active', stats?.active],
                ['Failed', stats?.failed],
                ['Delayed', stats?.delayed],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <p className="mono-label text-muted-foreground !mb-0 !text-[10px]">{label}</p>
                <p
                  className={cn(
                    'mono-data text-lg',
                    label === 'Failed' && (value ?? 0) > 0 && 'text-tone-bad font-semibold',
                  )}
                >
                  {typeof value === 'number' ? <CountUp value={value} /> : '—'}
                </p>
              </div>
            ))}
          </section>
          <p className="text-muted-foreground -mt-3 text-[11px]">
            {stats
              ? `Sampled ${new Date(stats.ts).toLocaleTimeString()} on ${queue.cacheStack}/${queue.cacheName}`
              : 'No sample yet — the reconciler probes every 15s.'}
          </p>
          <QueueRulesEditor queue={queue} />
          <QueueActions queue={queue} onRemoved={() => setOpen(false)} />
          {queue.dlq ? <QueueDlqPanel queue={queue} /> : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
