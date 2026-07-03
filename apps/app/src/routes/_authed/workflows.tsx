import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';

/**
 * Workflows moved into the stack workspace (`/stacks/$name/messaging`). This
 * route stays only as the layout for its `$runId` child (a run's timeline is
 * linked from the Messaging tab) — hitting exactly `/workflows` redirects
 * home to the stacks.
 */
export const Route = createFileRoute('/_authed/workflows')({
  beforeLoad: ({ location }) => {
    if (location.pathname.replace(/\/+$/, '') === '/workflows') {
      throw redirect({ to: '/' });
    }
  },
  component: Outlet,
});
