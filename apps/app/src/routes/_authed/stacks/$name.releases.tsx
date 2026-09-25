import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ReleasesTab } from '@/components/app-tabs/releases/releases-tab';

/** Releases tab: what is live, the rollout in flight, git environments + previews, history and put back. */
export const Route = createFileRoute('/_authed/stacks/$name/releases')({
  component: ReleasesTabRoute,
});

function ReleasesTabRoute(): React.JSX.Element {
  const { name } = Route.useParams();
  return <ReleasesTab stack={name} />;
}
