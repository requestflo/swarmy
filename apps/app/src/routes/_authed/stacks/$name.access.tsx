import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { AccessTabPage } from '@/components/app-access/access-tab-page';

/**
 * Access tab: who can reach this app — the login gate (swarmy's
 * identity-aware front door, who can enter, the app's own users) and laptop
 * access to its private services.
 */
export const Route = createFileRoute('/_authed/stacks/$name/access')({
  component: AccessTab,
});

function AccessTab(): React.JSX.Element {
  const { name } = Route.useParams();
  return <AccessTabPage stack={name} />;
}
