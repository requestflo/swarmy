import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { WorkspaceStub } from '@/components/stacks/workspace/workspace-stub';

/** Deploy a stack from a compose file — a focused full page, not a dialog. */
export const Route = createFileRoute('/_authed/stacks/new')({
  component: NewStackPage,
});

function NewStackPage(): React.JSX.Element {
  return <WorkspaceStub title="Compose deploy — moving in." />;
}
