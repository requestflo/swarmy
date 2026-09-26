import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { RolloutTab } from '@/components/app-tabs/rollout/rollout-tab';

/** Config › Health & rollout: the health watch and auto put-back, and starting a canary. */
export const Route = createFileRoute('/_authed/stacks/$name/config/rollout')({
  component: Page,
});

function Page(): React.JSX.Element {
  const { name } = Route.useParams();
  return <RolloutTab stack={name} />;
}
