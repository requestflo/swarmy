import { createFileRoute, redirect } from '@tanstack/react-router';

/** Queues moved into the stack workspace (the Messaging tab). */
export const Route = createFileRoute('/_authed/queues')({
  beforeLoad: () => {
    throw redirect({ to: '/' });
  },
});
