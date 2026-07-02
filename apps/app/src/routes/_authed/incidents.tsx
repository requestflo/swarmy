import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { IncidentsPage } from '@/components/incidents/incidents-page';

export const Route = createFileRoute('/_authed/incidents')({
  component: IncidentsRoute,
});

function IncidentsRoute(): React.JSX.Element {
  return <IncidentsPage />;
}
