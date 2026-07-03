import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { StackDomainsSection } from '@/components/ingress/stack-domains-section';
import { StackGeoSection } from '@/components/geo/stack-geo-section';

/** Network tab: ingress routes, protections & geo DNS for this stack. */
export const Route = createFileRoute('/_authed/stacks/$name/network')({
  component: NetworkTab,
});

function NetworkTab(): React.JSX.Element {
  const { name } = Route.useParams();
  return (
    <div className="space-y-10">
      <StackDomainsSection stack={name} />
      <StackGeoSection stack={name} />
    </div>
  );
}
