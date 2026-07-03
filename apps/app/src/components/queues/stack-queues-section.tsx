import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ListOrderedIcon, PlusIcon } from 'lucide-react';
import { Button, Card, CardContent, Collapsible, CollapsibleContent, CollapsibleTrigger, EmptyState } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { AttachQueueInline } from './attach-queue-inline';
import { QueueRow } from './queue-row';

/**
 * Queues section of the stack Messaging tab: this stack's queue defs (from
 * `swarmy.queues` labels on its worker services) as flat rows (row-expand for
 * depths/rules/actions/DLQ), plus the inline attach form.
 */
export function StackQueuesSection({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const [attaching, setAttaching] = React.useState(false);

  const queues = useQuery({
    ...trpc.queues.list.queryOptions({ stack }),
    refetchInterval: 5_000,
  });
  const rows = queues.data ?? [];
  const totalFailed = rows.reduce((n, q) => n + (q.stats?.failed ?? 0), 0);

  return (
    <Card className="card-pop border-0">
      <CardContent className="space-y-4 p-6">
        <Collapsible open={attaching} onOpenChange={setAttaching}>
          <div className="flex flex-wrap items-center gap-3">
            <span className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
              <ListOrderedIcon className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="font-semibold leading-tight">Queues</h3>
              <p className="text-muted-foreground mono-label !mb-0">
                {totalFailed > 0
                  ? `${totalFailed.toLocaleString()} failed jobs need attention`
                  : 'depths, autoscale, dead letters'}
              </p>
            </div>
            <CollapsibleTrigger asChild>
              <Button variant="outline" className="shrink-0">
                <PlusIcon className="size-4" /> Attach queue
              </Button>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent>
            <div className="border-border bg-muted/20 mt-4 rounded-lg border p-4">
              <AttachQueueInline onDone={() => setAttaching(false)} />
            </div>
          </CollapsibleContent>
        </Collapsible>

        {queues.isLoading ? (
          <div className="space-y-2">
            <div className="shimmer-line h-12 rounded-lg" />
            <div className="shimmer-line h-12 rounded-lg" />
          </div>
        ) : queues.isError ? (
          <div className="flex flex-wrap items-center gap-3 py-2">
            <p className="text-status-offline text-sm">{queues.error.message}</p>
            <Button variant="outline" size="sm" onClick={() => void queues.refetch()}>
              Retry
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<ListOrderedIcon />}
            title={`No queues in ${stack} yet — attach one.`}
            description="Point swarmy at a worker service and its cache cluster: it reads BullMQ (or raw list) depths, scales workers by backlog, and gives you retry, drain and a DLQ browser."
            action={
              <Button variant="outline" onClick={() => setAttaching(true)}>
                <PlusIcon className="size-4" /> Attach queue
              </Button>
            }
          />
        ) : (
          <div className="divide-border divide-y">
            {rows.map((q) => (
              <QueueRow key={`${q.workerService}/${q.name}`} queue={q} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
