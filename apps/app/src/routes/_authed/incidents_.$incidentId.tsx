import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { IncidentDetailPage } from '@/components/incidents/incident-detail-page';

export const Route = createFileRoute('/_authed/incidents_/$incidentId')({
  component: IncidentDetailRoute,
});

function IncidentDetailRoute(): React.JSX.Element {
  const { incidentId } = Route.useParams();
  return <IncidentDetailPage incidentId={incidentId} />;
}
