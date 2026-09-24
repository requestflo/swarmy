import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { AppAccessSection } from '@/components/app-access/app-access-section';

/** Access tab: Require login (swarmy's identity-aware proxy), who can enter, and the app's own users. */
export const Route = createFileRoute('/_authed/stacks/$name/access')({
  component: AccessTab,
});

function AccessTab(): React.JSX.Element {
  const { name } = Route.useParams();
  return <AppAccessSection stack={name} />;
}
