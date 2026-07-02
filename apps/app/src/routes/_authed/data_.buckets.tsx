import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ArchiveIcon } from 'lucide-react';
import { EmptyState } from '@swarmy/ui';
import { PageHeader } from '@/components/page-header';

export const Route = createFileRoute('/_authed/data_/buckets')({
  component: Page,
});

function Page(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Data"
        title={
          <>
            Buckets
          </>
        }
        description="S3-compatible object storage on your own nodes — buckets, access keys and app attachment."
      />
      <div className="card-pop p-2">
        <EmptyState
          icon={<ArchiveIcon />}
          title="Coming online"
          description="This managed service is being wired up."
        />
      </div>
    </div>
  );
}
