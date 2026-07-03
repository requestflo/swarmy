import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { StackSettingsTab } from '@/components/ai/stack-settings/stack-settings-tab';

/** Settings tab: environment, AI-gateway access & outlet, add-service, danger zone. */
export const Route = createFileRoute('/_authed/stacks/$name/settings')({
  component: SettingsTab,
});

function SettingsTab(): React.JSX.Element {
  const { name } = Route.useParams();
  return <StackSettingsTab stack={name} />;
}
