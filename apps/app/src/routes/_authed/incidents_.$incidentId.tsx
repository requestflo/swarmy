import { createFileRoute, redirect } from '@tanstack/react-router';

/** An incident now opens in the room beside the Stream; old deep links still land. */
export const Route = createFileRoute('/_authed/incidents_/$incidentId')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/activity', search: { incident: params.incidentId }, replace: true });
  },
});
