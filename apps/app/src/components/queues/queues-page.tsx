import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ListOrderedIcon } from 'lucide-react';
import type { QueueView } from '@swarmy/core';
import { Button, EmptyState } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { AttachQueueDialog } from './attach-queue-dialog';
import { QueueDetailSheet } from './queue-detail-sheet';
import { QueuesTable } from './queues-table';

/**
 * Operations → Queues: every queue in the org (from `swarmy.queues` labels),
 * live depths, autoscaled workers, and the attach wizard + detail sheet.
 */
export function QueuesPage(): React.JSX.Element {
  const trpc = useTRPC();
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);

  const queues = useQuery({
    ...trpc.queues.list.queryOptions(),
    refetchInterval: 5_000,
  });

  const rows = queues.data ?? [];
  const totalWait = rows.reduce((n, q) => n + (q.stats?.wait ?? 0), 0);
  const totalFailed = rows.reduce((n, q) => n + (q.stats?.failed ?? 0), 0);
  const selected = rows.find((q) => `${q.workerService}/${q.name}` === selectedKey) ?? null;

  const title =
    rows.length === 0 ? (
      <>
        Queues, <em>working</em>.
      </>
    ) : totalFailed > 0 ? (
      <>
        {totalFailed.toLocaleString()} failed jobs need <em>you</em>.
      </>
    ) : (
      <>
        {totalWait.toLocaleString()} waiting — all <em>moving</em>.
      </>
    );

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Operations · Queues"
        title={title}
        description="Background queues on your managed caches — swarmy watches depths, autoscales workers between your min/max, and catches dead letters."
        actions={<AttachQueueDialog />}
      />

      {queues.isLoading ? (
        <div className="card-pop space-y-3 p-5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="shimmer-line h-12 rounded-lg" />
          ))}
        </div>
      ) : queues.isError ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<ListOrderedIcon />}
            title="Couldn't load queues"
            description={queues.error.message}
            action={
              <Button variant="outline" onClick={() => void queues.refetch()}>
                Retry
              </Button>
            }
          />
        </div>
      ) : rows.length === 0 ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<ListOrderedIcon />}
            title="No queues yet — attach one."
            description="Point swarmy at a worker service and its cache cluster: it reads BullMQ (or raw list) depths, scales workers by backlog, and gives you retry, drain and a DLQ browser."
            action={<AttachQueueDialog variant="outline" />}
          />
        </div>
      ) : (
        <QueuesTable
          queues={rows}
          onOpen={(q: QueueView) => setSelectedKey(`${q.workerService}/${q.name}`)}
        />
      )}

      <QueueDetailSheet
        queue={selected}
        onOpenChange={(open) => {
          if (!open) setSelectedKey(null);
        }}
      />
    </div>
  );
}
