import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { RunPage } from '@/components/workflows/run-page';

export const Route = createFileRoute('/_authed/workflows/$runId')({
  component: WorkflowRunRoute,
});

function WorkflowRunRoute(): React.JSX.Element {
  const { runId } = Route.useParams();
  return <RunPage runId={runId} />;
}
