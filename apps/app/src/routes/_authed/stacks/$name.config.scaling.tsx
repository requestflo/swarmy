import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ScalingTab } from '@/components/app-tabs/scaling/scaling-tab';

/** Config › Scaling: one service at a time — where it runs, copies, size, sleep when idle — then (Controls) the app’s own settings. */
export const Route = createFileRoute('/_authed/stacks/$name/config/scaling')({
  component: Page,
});

function Page(): React.JSX.Element {
  const { name } = Route.useParams();
  return <ScalingTab stack={name} />;
}
