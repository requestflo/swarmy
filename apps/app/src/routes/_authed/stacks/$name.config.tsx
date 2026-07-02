import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { WorkspaceStub } from '@/components/stacks/workspace/workspace-stub';

/** Config tab: secrets & configs for this stack. */
export const Route = createFileRoute('/_authed/stacks/$name/config')({
  component: ConfigTab,
});

function ConfigTab(): React.JSX.Element {
  return <WorkspaceStub title="Secrets & configs — moving in." />;
}
