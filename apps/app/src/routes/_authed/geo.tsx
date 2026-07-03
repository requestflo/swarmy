import { createFileRoute, redirect } from '@tanstack/react-router';

/** Geo-DNS moved into the stack workspace (the Network tab) + the Edge & ingress footer. */
export const Route = createFileRoute('/_authed/geo')({
  beforeLoad: () => {
    throw redirect({ to: '/' });
  },
});
