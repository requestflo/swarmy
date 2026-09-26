import { createFileRoute, redirect } from '@tanstack/react-router';

/** Incidents moved into Activity › Stream (the Incidents filter); old links still land. */
export const Route = createFileRoute('/_authed/incidents')({
  beforeLoad: () => {
    throw redirect({ to: '/activity', search: { filter: 'incident' }, replace: true });
  },
});
