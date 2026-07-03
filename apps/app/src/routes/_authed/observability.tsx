import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';

/**
 * Observability moved into the stack workspace (`/stacks/$name/observability`).
 * This route stays only as the layout for its `$traceId` child (the trace
 * waterfall is cross-stack, linked from traces + logs) — hitting exactly
 * `/observability` redirects home to the stacks.
 */
export const Route = createFileRoute('/_authed/observability')({
  beforeLoad: ({ location }) => {
    if (location.pathname.replace(/\/+$/, '') === '/observability') {
      throw redirect({ to: '/' });
    }
  },
  component: Outlet,
});
