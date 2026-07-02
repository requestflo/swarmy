import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { BoxIcon } from 'lucide-react';
import { EmptyState } from '@swarmy/ui';
import { PageHeader } from '@/components/page-header';

export const Route = createFileRoute('/_authed/data_/vector')({
  component: Page,
});

function Page(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Data"
        title={
          <>
            Vector stores
          </>
        }
        description="Managed Qdrant and pgvector — vector databases for AI workloads."
      />
      <div className="card-pop p-2">
        <EmptyState
          icon={<BoxIcon />}
          title="Coming online"
          description="This managed service is being wired up."
        />
      </div>
    </div>
  );
}
