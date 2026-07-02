import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { WorkspaceStub } from '@/components/stacks/workspace/workspace-stub';

/** Data tab: managed databases, caches, search & vector for this stack. */
export const Route = createFileRoute('/_authed/stacks/$name/data')({
  component: DataTab,
});

function DataTab(): React.JSX.Element {
  return <WorkspaceStub title="Databases, caches, search & vector — moving in." />;
}
