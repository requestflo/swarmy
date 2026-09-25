import * as React from 'react';
import { createFileRoute, Outlet } from '@tanstack/react-router';
import { StackWorkspaceLayout } from '@/components/stacks/workspace/stack-workspace-layout';

/**
 * The app workspace — an app (a Docker stack) is a real URL and the unit you
 * operate. Child routes are its tabs (Overview · Logs · Domains · Data ·
 * Variables & secrets · Releases · Access · …, see lib/stack-nav.ts).
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
