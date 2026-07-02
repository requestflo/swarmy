import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { WorkflowIcon } from 'lucide-react';
import { EmptyState } from '@swarmy/ui';
import { PageHeader } from '@/components/page-header';

export const Route = createFileRoute('/_authed/workflows/$runId')({
  component: WorkflowRunPage,
});

function WorkflowRunPage(): React.JSX.Element {
  const { runId } = Route.useParams();
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Operations · Workflow run"
        title={
          <>
            Workflow <em>run</em>.
          </>
        }
        description={`Run ${runId} — details will appear here once the slice lands.`}
      />
      <div className="card-pop p-2">
        <EmptyState
          icon={<WorkflowIcon />}
          title="Run details land here"
          description="Step timeline, per-step output and approval controls arrive with the workflow engine."
        />
      </div>
    </div>
  );
}
