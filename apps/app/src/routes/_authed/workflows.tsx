import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { WorkflowIcon } from 'lucide-react';
import { EmptyState } from '@swarmy/ui';
import { PageHeader } from '@/components/page-header';

export const Route = createFileRoute('/_authed/workflows')({
  component: WorkflowsPage,
});

function WorkflowsPage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Operations · Workflows"
        title={
          <>
            <em>Workflows</em>.
          </>
        }
        description="Multi-step automations — containers, execs, webhooks, approvals and delays — versioned and replayable."
      />
      <div className="card-pop p-2">
        <EmptyState
          icon={<WorkflowIcon />}
          title="No workflows yet"
          description="Define a workflow — steps, approvals, delays — then trigger it manually or from a webhook."
        />
      </div>
    </div>
  );
}
