import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * Status pages moved into each stack's Observability tab
 * (`/stacks/$name/observability`) — the old global surface redirects home.
 */
export const Route = createFileRoute('/_authed/status-pages')({
  beforeLoad: () => {
    throw redirect({ to: '/' });
  },
});
