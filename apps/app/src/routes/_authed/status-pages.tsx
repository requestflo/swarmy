import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { RadioTowerIcon } from 'lucide-react';
import { EmptyState } from '@swarmy/ui';
import { PageHeader } from '@/components/page-header';

export const Route = createFileRoute('/_authed/status-pages')({
  component: StatusPagesPage,
});

function StatusPagesPage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Operations · Status pages"
        title={
          <>
            Status <em>pages</em>.
          </>
        }
        description="Public status pages for your services — components, uptime bars and incident history."
      />
      <div className="card-pop p-2">
        <EmptyState
          icon={<RadioTowerIcon />}
          title="No status pages yet"
          description="Create a page, pick components and share a public URL your users can trust."
        />
      </div>
    </div>
  );
}
