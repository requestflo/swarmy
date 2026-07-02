import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ListOrderedIcon } from 'lucide-react';
import type { QueueView } from '@swarmy/core';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  StatusBadge,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CountUp } from '@/components/count-up';
import { queueTone } from './queues-table';
import { QueueActions } from './queue-actions';
import { QueueDlqPanel } from './queue-dlq-panel';
import { QueueRulesEditor } from './queue-rules-editor';

/**
 * Queue detail: live depths (polled straight off the cache primary), worker
 * autoscale state, scale-rule editor, retry/drain actions and the DLQ browser.
 */
export function QueueDetailSheet({
  queue,
  onOpenChange,
}: {
  queue: QueueView | null;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const open = queue !== null;

  const live = useQuery({
    ...trpc.queues.stats.queryOptions({
      workerService: queue?.workerService ?? '',
      queue: queue?.name ?? '',
    }),
    enabled: open,
    refetchInterval: 3_000,
    retry: false,
  });

  const stats = live.data ?? queue?.stats ?? null;
  const tone = queue ? queueTone(queue) : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto p-0 sm:max-w-md">
        <SheetHeader className="border-border border-b p-6">
          <div className="flex items-center gap-3">
            <span className="bg-primary/10 text-primary flex size-9 items-center justify-center rounded-lg">
              <ListOrderedIcon className="size-5" />
            </span>
            <div className="min-w-0">
              <SheetTitle className="truncate">{queue?.name ?? 'Queue'}</SheetTitle>
              <SheetDescription className="mono-label !mb-0">
                {queue ? `${queue.convention === 'bullmq' ? 'BullMQ' : 'raw list'} · ${queue.cacheStack}/${queue.cacheName}` : '…'}
              </SheetDescription>
            </div>
            {tone ? (
              <StatusBadge tone={tone.tone} label={tone.label} className="ml-auto shrink-0" />
            ) : null}
          </div>
        </SheetHeader>

        {!queue ? null : (
          <div className="space-y-6 p-6">
            <section className="space-y-2">
              <div className="grid grid-cols-4 gap-2">
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
                    <p className={`mono-data text-lg ${label === 'Failed' && (value ?? 0) > 0 ? 'text-status-offline font-semibold' : ''}`}>
                      {typeof value === 'number' ? <CountUp value={value} /> : '—'}
                    </p>
                  </div>
                ))}
              </div>
              <p className="text-muted-foreground text-[11px]">
                {stats
                  ? `Sampled ${new Date(stats.ts).toLocaleTimeString()} on ${queue.cacheStack}/${queue.cacheName}${live.isError ? ' (last stamp — live probe failed)' : ''}`
                  : 'No sample yet — the reconciler probes every 15s.'}
              </p>
            </section>

            <section className="space-y-1">
              <p className="mono-label text-muted-foreground !mb-0">Workers</p>
              <p className="text-sm">
                <span className="mono-data font-semibold">
                  {queue.workers.running}/{queue.workers.desired}
                </span>{' '}
                running on <code className="mono-data text-xs">{queue.workerService}</code>{' '}
                <span className="text-muted-foreground text-xs">(cap {queue.maxWorkers})</span>
              </p>
            </section>

            <QueueRulesEditor queue={queue} />
            <QueueActions queue={queue} onRemoved={() => onOpenChange(false)} />
            {queue.dlq ? <QueueDlqPanel queue={queue} /> : null}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
