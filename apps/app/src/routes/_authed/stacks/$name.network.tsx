import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { DomainsTabPage } from '@/components/app-domains/domains-tab-page';

/** Domains tab: this app's addresses, their HTTPS state and protections, and geo-DNS. */
export const Route = createFileRoute('/_authed/stacks/$name/network')({
  component: NetworkTab,
});

function NetworkTab(): React.JSX.Element {
  const { name } = Route.useParams();
  return <DomainsTabPage stack={name} />;
}
