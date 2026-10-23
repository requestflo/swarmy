import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ConnectionsPage } from '@/components/connections/connections-page';

/** Network › Connections. `?app=` picks the app (the app's Access tab links here with it). */
interface ConnectionsSearch {
  app?: string;
}

export const Route = createFileRoute('/_authed/network_/connections')({
  validateSearch: (search: Record<string, unknown>): ConnectionsSearch =>
    typeof search.app === 'string' && search.app ? { app: search.app.slice(0, 120) } : {},
  component: ConnectionsRoute,
});

function ConnectionsRoute(): React.JSX.Element {
  const { app } = Route.useSearch();
  return <ConnectionsPage key={app ?? ''} app={app} />;
}
