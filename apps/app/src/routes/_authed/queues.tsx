import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ListOrderedIcon } from 'lucide-react';
import { EmptyState } from '@swarmy/ui';
import { PageHeader } from '@/components/page-header';

export const Route = createFileRoute('/_authed/queues')({
  component: QueuesPage,
});

function QueuesPage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Operations · Queues"
        title={
          <>
            <em>Queues</em>.
          </>
        }
        description="Queue depths, workers, autoscaling and dead letters — backed by your managed cache clusters."
      />
      <div className="card-pop p-2">
        <EmptyState
          icon={<ListOrderedIcon />}
          title="No queues yet"
          description="Attach a queue to a worker service and a cache cluster to see depth, workers and dead letters."
        />
      </div>
    </div>
  );
}
