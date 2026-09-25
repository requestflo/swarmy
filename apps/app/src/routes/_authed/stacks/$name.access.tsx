import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { AppAccessSection } from '@/components/app-access/app-access-section';
import { ConnectFromLaptop } from '@/components/networking/connect-from-laptop';

/**
 * Access tab: everything about who can reach this app — the login gate
 * (swarmy's identity-aware proxy, who can enter, the app's own users) and
 * laptop access to its private services over the mesh.
 */
export const Route = createFileRoute('/_authed/stacks/$name/access')({
  component: AccessTab,
});

function AccessTab(): React.JSX.Element {
  const { name } = Route.useParams();
  return (
    <div className="space-y-10">
      <AppAccessSection stack={name} />
      <ConnectFromLaptop stack={name} />
    </div>
  );
}
