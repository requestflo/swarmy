import { createFileRoute, redirect } from '@tanstack/react-router';

/** Resilience moved into each stack's Backups tab — this page is gone. */
export const Route = createFileRoute('/_authed/resilience')({
  beforeLoad: () => {
    throw redirect({ to: '/' });
  },
});
