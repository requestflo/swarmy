import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { RumSettingsPage } from '@/components/rum/rum-settings-page';

/** Observability → Replay & analytics settings for this app. */
export const Route = createFileRoute('/_authed/stacks/$name/rum-settings')({
  component: RumSettingsRoute,
});

function RumSettingsRoute(): React.JSX.Element {
  const { name } = Route.useParams();
  return <RumSettingsPage stack={name} />;
}
