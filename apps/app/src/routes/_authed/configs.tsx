import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * Configs moved into the stack workspace: every stack's Config tab shows the
 * configs attached to it (plus unattached ones). The old global page redirects
 * home, where each stack is one click away.
 */
export const Route = createFileRoute('/_authed/configs')({
  beforeLoad: () => {
    throw redirect({ to: '/' });
  },
});
