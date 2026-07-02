import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCwIcon, UndoIcon } from 'lucide-react';
import type { QueueView } from '@swarmy/core';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/** Dead-letter browser: exhausted jobs from `<queue>:dead`, with requeue. */
export function QueueDlqPanel({ queue }: { queue: QueueView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const ref = { workerService: queue.workerService, queue: queue.name };

  const items = useQuery({
    ...trpc.queues.dlqList.queryOptions({ ...ref, limit: 50 }),
    refetchInterval: 10_000,
    retry: false,
  });

  const requeue = useMutation(
    trpc.queues.dlqRequeue.mutationOptions({
      onSuccess: (r) => {
        toast.success(`${r.moved} dead jobs requeued (${r.remaining} left)`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const rows = items.data ?? [];

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="mono-label text-muted-foreground !mb-0">Dead letters</p>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            disabled={items.isFetching}
            onClick={() => void items.refetch()}
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={requeue.isPending || rows.length === 0}
            onClick={() => requeue.mutate({ ...ref, limit: 100 })}
          >
            <UndoIcon className="size-3.5" /> {requeue.isPending ? 'Requeuing…' : 'Requeue all'}
          </Button>
        </div>
      </div>
      {items.isLoading ? (
        <div className="shimmer-line h-16 rounded-lg" />
      ) : items.isError ? (
        <p className="text-status-offline text-xs">Couldn&apos;t read the DLQ: {items.error.message}</p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          Nothing dead — jobs land in <code className="mono-data">{queue.name}:dead</code> after{' '}
          {queue.retries} failed attempts.
        </p>
      ) : (
        <div className="border-border divide-border max-h-56 divide-y overflow-y-auto rounded-lg border">
          {rows.map((it) => (
            <pre
              key={it.index}
              className="mono-data text-muted-foreground max-w-full overflow-x-auto px-3 py-2 text-[11px] whitespace-pre-wrap break-all"
            >
              {it.payload}
            </pre>
          ))}
        </div>
      )}
    </section>
  );
}
