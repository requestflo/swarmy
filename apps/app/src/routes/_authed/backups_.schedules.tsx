import { createFileRoute, redirect } from '@tanstack/react-router';

/** Schedules & DR moved into each stack's Backups tab — this page is gone. */
export const Route = createFileRoute('/_authed/backups_/schedules')({
  beforeLoad: () => {
    throw redirect({ to: '/' });
  },
});
