import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { WorkspaceStub } from '@/components/stacks/workspace/workspace-stub';

/** Settings tab: AI-gateway access, exposure & the danger zone for this stack. */
export const Route = createFileRoute('/_authed/stacks/$name/settings')({
  component: SettingsTab,
});

function SettingsTab(): React.JSX.Element {
  return <WorkspaceStub title="Stack settings & AI access — moving in." />;
}
