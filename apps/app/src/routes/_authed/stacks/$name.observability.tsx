import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { WorkspaceStub } from '@/components/stacks/workspace/workspace-stub';

/** Observability tab: logs, metrics, traces, health & status page for this stack. */
export const Route = createFileRoute('/_authed/stacks/$name/observability')({
  component: ObservabilityTab,
});

function ObservabilityTab(): React.JSX.Element {
  return <WorkspaceStub title="Logs, metrics, traces & status page — moving in." />;
}
