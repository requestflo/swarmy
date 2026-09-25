import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { Button, Collapsible, CollapsibleContent } from '@swarmy/ui';
import { Depth, Section } from '@/components/calm';
import { RowsSkeleton } from '@/components/app-tabs/tab-body';
import { useTRPC } from '@/integrations/trpc';
import { AttachQueueInline } from './attach-queue-inline';
import { QueueRow } from './queue-row';
import { AddQueueInline } from './studio/add-queue-inline';
import { QueueClustersStrip } from './studio/queue-clusters-strip';

/**
 * Queues section of the stack Messaging tab: this stack's queue defs (from
 * `swarmy.queues` labels on its worker services) as flat rows (row-expand for
 * depths/rules/actions/DLQ), plus the inline attach form.
 */
export function StackQueuesSection({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const [attaching, setAttaching] = React.useState(false);
  const [adding, setAdding] = React.useState(false);

  const queues = useQuery({
    ...trpc.queues.list.queryOptions({ stack }),
    refetchInterval: 5_000,
  });
  const rows = queues.data ?? [];
  const totalFailed = rows.reduce((n, q) => n + (q.stats?.failed ?? 0), 0);

  return (
    <Section
      title="Queues"
      count={queues.data ? rows.length : undefined}
      hint={totalFailed > 0 ? `${totalFailed.toLocaleString()} failed jobs` : 'work your app hands to its workers'}
      flush
      action={
        <Depth at="controls">
          <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" onClick={() => setAdding((v) => !v)}>
            <PlusIcon className="size-3.5" /> Add a queue
          </Button>
          <Button variant="ghost" size="sm" className="pointer-coarse:min-h-11" onClick={() => setAttaching((v) => !v)}>
            Attach a worker
          </Button>
        </Depth>
      }
    >
      <Collapsible open={attaching} onOpenChange={setAttaching}>
        <CollapsibleContent>
          <div className="border-border mb-3 rounded-xl border p-4">
            <AttachQueueInline onDone={() => setAttaching(false)} />
          </div>
        </CollapsibleContent>
      </Collapsible>
        {adding ? (
          <div className="border-border mb-3 rounded-xl border p-4">
            <AddQueueInline stack={stack} onDone={() => setAdding(false)} />
          </div>
        ) : null}
        <Depth at="controls">
          <div className="pb-2">
            <QueueClustersStrip stack={stack} />
          </div>
        </Depth>

        {queues.isPending ? (
          <RowsSkeleton rows={2} />
        ) : queues.isError ? (
          <div className="flex flex-wrap items-center gap-3 py-2">
            <p className="text-tone-bad text-sm">{queues.error.message}</p>
            <Button variant="outline" size="sm" onClick={() => void queues.refetch()}>
              Retry
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground py-3 text-[13.5px]">
            No queues yet. Add one and attach the worker that reads it: swarmy scales workers by backlog and keeps failed jobs
            for a retry.
          </p>
        ) : (
          <div className="divide-border divide-y">
            {rows.map((q) => (
              <QueueRow key={`${q.workerService}/${q.name}`} queue={q} />
            ))}
          </div>
        )}
    </Section>
  );
}
