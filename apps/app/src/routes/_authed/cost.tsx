import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { CircleDollarSignIcon } from 'lucide-react';
import { EmptyState } from '@swarmy/ui';
import { PageHeader } from '@/components/page-header';

export const Route = createFileRoute('/_authed/cost')({
  component: CostPage,
});

function CostPage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Governance · Cost"
        title={
          <>
            <em>Cost</em>.
          </>
        }
        description="What your estate costs and where it’s wasted — per node, per stack, with recommendations."
      />
      <div className="card-pop p-2">
        <EmptyState
          icon={<CircleDollarSignIcon />}
          title="No cost data yet"
          description="Set a monthly cost on each node and swarmy breaks down spend per stack."
        />
      </div>
    </div>
  );
}
