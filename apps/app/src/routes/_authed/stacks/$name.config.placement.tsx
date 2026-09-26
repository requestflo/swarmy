import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { PlacementTab } from '@/components/app-tabs/scaling/placement-tab';

/** Config › Placement & volumes: which servers each part may run on. */
export const Route = createFileRoute('/_authed/stacks/$name/config/placement')({
  component: Page,
});

function Page(): React.JSX.Element {
  const { name } = Route.useParams();
  return <PlacementTab stack={name} />;
}
