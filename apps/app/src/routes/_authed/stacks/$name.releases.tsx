import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { StackReleases } from '@/components/releases/stack-releases';

/** Releases tab: this stack's deploy history, canary rollout and safety. */
export const Route = createFileRoute('/_authed/stacks/$name/releases')({
  component: ReleasesTab,
});

function ReleasesTab(): React.JSX.Element {
  const { name } = Route.useParams();
  return <StackReleases stack={name} />;
}
