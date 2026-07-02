import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { WorkspaceStub } from '@/components/stacks/workspace/workspace-stub';

/** Releases tab: history, canary & rollback for this stack. */
export const Route = createFileRoute('/_authed/stacks/$name/releases')({
  component: ReleasesTab,
});

function ReleasesTab(): React.JSX.Element {
  return <WorkspaceStub title="Releases, canary & rollback — moving in." />;
}
