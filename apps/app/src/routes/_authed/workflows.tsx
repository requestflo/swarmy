import * as React from 'react';
import { Outlet, createFileRoute, useChildMatches } from '@tanstack/react-router';
import { WorkflowsPage } from '@/components/workflows/workflows-page';

export const Route = createFileRoute('/_authed/workflows')({
  component: WorkflowsRoute,
});

/** `/workflows` renders the surface; `/workflows/$runId` renders through the Outlet. */
function WorkflowsRoute(): React.JSX.Element {
  const hasChild = useChildMatches().length > 0;
  return hasChild ? <Outlet /> : <WorkflowsPage />;
}
