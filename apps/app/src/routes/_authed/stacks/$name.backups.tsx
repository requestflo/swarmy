import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { WorkspaceStub } from '@/components/stacks/workspace/workspace-stub';

/** Backups tab: DR setup & resilience for this stack. */
export const Route = createFileRoute('/_authed/stacks/$name/backups')({
  component: BackupsTab,
});

function BackupsTab(): React.JSX.Element {
  return <WorkspaceStub title="Backups, DR & resilience — moving in." />;
}
