import { createFileRoute, redirect } from '@tanstack/react-router';

/** Scheduled jobs moved into the stack workspace (the Messaging tab). */
export const Route = createFileRoute('/_authed/jobs')({
  beforeLoad: () => {
    throw redirect({ to: '/' });
  },
});
