import * as React from 'react';
import { createFileRoute, Outlet } from '@tanstack/react-router';
import { StackWorkspaceLayout } from '@/components/stacks/workspace/stack-workspace-layout';

/**
 * The app workspace — an app (a Docker stack) is a real URL and the unit you
 * operate. Child routes are its tabs (Services · Domains · Data ·
 * Observability · Access · Config · Backups · Releases · Source, with
 * sub-tabs; see lib/stack-nav.ts).
 */
interface StackWorkspaceSearch {
  /** Set right after a deploy: the page shows "Deploying → It's live" (components/deploy/deploy-flow). */
  deployed?: number;
}

export const Route = createFileRoute('/_authed/stacks/$name')({
  validateSearch: (search: Record<string, unknown>): StackWorkspaceSearch =>
    search.deployed === 1 || search.deployed === '1' || search.deployed === true ? { deployed: 1 } : {},
  component: StackWorkspacePage,
});

function StackWorkspacePage(): React.JSX.Element {
  const { name } = Route.useParams();
  const { deployed } = Route.useSearch();
  return (
    <StackWorkspaceLayout stack={name} deployed={deployed === 1}>
      <Outlet />
    </StackWorkspaceLayout>
  );
}
