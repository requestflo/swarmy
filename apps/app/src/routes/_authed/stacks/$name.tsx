import * as React from 'react';
import { createFileRoute, Outlet } from '@tanstack/react-router';
import { StackWorkspaceLayout } from '@/components/stacks/workspace/stack-workspace-layout';

/**
 * The stack workspace — a stack is a real URL and the primary unit you
 * operate. Child routes are the workspace tabs (Overview canvas, Data,
 * Messaging, Observability, Network, Config, Backups, Releases, Settings).
 */
export const Route = createFileRoute('/_authed/stacks/$name')({
  component: StackWorkspacePage,
});

function StackWorkspacePage(): React.JSX.Element {
  const { name } = Route.useParams();
  return (
    <StackWorkspaceLayout stack={name}>
      <Outlet />
    </StackWorkspaceLayout>
  );
}
