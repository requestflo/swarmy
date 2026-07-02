import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { WorkspaceStub } from '@/components/stacks/workspace/workspace-stub';

/** Messaging tab: queues, workflows, webhooks & scheduled jobs for this stack. */
export const Route = createFileRoute('/_authed/stacks/$name/messaging')({
  component: MessagingTab,
});

function MessagingTab(): React.JSX.Element {
  return <WorkspaceStub title="Queues, workflows, webhooks & jobs — moving in." />;
}
