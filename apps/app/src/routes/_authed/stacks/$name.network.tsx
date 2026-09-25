import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { DomainsTabPage } from '@/components/app-domains/domains-tab-page';

/** Domains tab: this app's addresses, their HTTPS state and protections, and geo-DNS. */
/** `?add=` opens the Add a domain form (⌘K "add a domain to shop"); a value prefills the host. */
interface NetworkSearch {
  add?: string;
}

export const Route = createFileRoute('/_authed/stacks/$name/network')({
  validateSearch: (search: Record<string, unknown>): NetworkSearch =>
    typeof search.add === 'string' ? { add: search.add.slice(0, 253) } : {},
  component: NetworkTab,
});

function NetworkTab(): React.JSX.Element {
  const { name } = Route.useParams();
  const { add } = Route.useSearch();
  return <DomainsTabPage key={add ?? ''} stack={name} add={add} />;
}
