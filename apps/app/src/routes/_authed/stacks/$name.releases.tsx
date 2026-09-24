import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { StackReleases } from '@/components/releases/stack-releases';
import { StackGitAppPanel } from '@/components/gitops/stack-git-app-panel';

/** Releases tab: the git source (for git apps), deploy history, canary rollout and safety. */
export const Route = createFileRoute('/_authed/stacks/$name/releases')({
  component: ReleasesTab,
});

function ReleasesTab(): React.JSX.Element {
  const { name } = Route.useParams();
  return (
    <>
      <StackGitAppPanel stack={name} />
      <StackReleases stack={name} />
    </>
  );
}
