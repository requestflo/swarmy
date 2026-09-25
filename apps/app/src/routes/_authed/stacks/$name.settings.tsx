import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { SettingsTab } from '@/components/app-tabs/scaling/settings-tab';

/** Settings tab: copies and where they run; from Controls, environment, AI gateway, add-service, danger zone. */
export const Route = createFileRoute('/_authed/stacks/$name/settings')({
  component: SettingsTabRoute,
});

function SettingsTabRoute(): React.JSX.Element {
  const { name } = Route.useParams();
  return <SettingsTab stack={name} />;
}
