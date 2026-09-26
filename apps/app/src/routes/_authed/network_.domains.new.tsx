import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { AddDomainPage } from '@/components/domains/add-domain-page';

/** `?app=` preselects that app; `?host=` prefills the domain (⌘K "add shop.example.com to storefront"). */
interface AddDomainSearch {
  app?: string;
  host?: string;
}

export const Route = createFileRoute('/_authed/network_/domains/new')({
  validateSearch: (search: Record<string, unknown>): AddDomainSearch => ({
    ...(typeof search.app === 'string' && search.app ? { app: search.app.slice(0, 120) } : {}),
    ...(typeof search.host === 'string' && search.host ? { host: search.host.slice(0, 253) } : {}),
  }),
  component: AddDomainRoute,
});

function AddDomainRoute(): React.JSX.Element {
  const { app, host } = Route.useSearch();
  return <AddDomainPage key={`${app ?? ''}|${host ?? ''}`} app={app} host={host} />;
}
