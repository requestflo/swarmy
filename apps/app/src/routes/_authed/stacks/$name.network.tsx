import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { WorkspaceStub } from '@/components/stacks/workspace/workspace-stub';

/** Network tab: ingress routes, protections & geo DNS for this stack. */
export const Route = createFileRoute('/_authed/stacks/$name/network')({
  component: NetworkTab,
});

function NetworkTab(): React.JSX.Element {
  return <WorkspaceStub title="Domains, protections & geo DNS — moving in." />;
}
