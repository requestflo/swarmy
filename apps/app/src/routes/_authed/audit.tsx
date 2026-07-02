import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ScrollTextIcon } from 'lucide-react';
import { EmptyState } from '@swarmy/ui';
import { PageHeader } from '@/components/page-header';

export const Route = createFileRoute('/_authed/audit')({
  component: AuditPage,
});

function AuditPage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Governance · Audit"
        title={
          <>
            Audit <em>log</em>.
          </>
        }
        description="Who did what, when — every action across the org, filterable and exportable."
      />
      <div className="card-pop p-2">
        <EmptyState
          icon={<ScrollTextIcon />}
          title="No audit entries yet"
          description="Every mutation in the org is recorded — filter by actor, action, resource or date."
        />
      </div>
    </div>
  );
}
