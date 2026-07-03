import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * Secrets moved into the stack workspace: every stack's Config tab shows the
 * secrets attached to it (plus unattached ones). The old global page redirects
 * home, where each stack is one click away.
 */
export const Route = createFileRoute('/_authed/secrets')({
  beforeLoad: () => {
    throw redirect({ to: '/' });
  },
});
