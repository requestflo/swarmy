import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { SearchIcon } from 'lucide-react';
import { EmptyState } from '@swarmy/ui';
import { PageHeader } from '@/components/page-header';

export const Route = createFileRoute('/_authed/data_/search')({
  component: Page,
});

function Page(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Data"
        title={
          <>
            Search
          </>
        }
        description="Managed Meilisearch and Typesense — private search engines attached to your apps."
      />
      <div className="card-pop p-2">
        <EmptyState
          icon={<SearchIcon />}
          title="Coming online"
          description="This managed service is being wired up."
        />
      </div>
    </div>
  );
}
