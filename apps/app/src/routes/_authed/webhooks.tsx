import { createFileRoute, redirect } from '@tanstack/react-router';

/** Webhooks moved into the stack workspace (the Messaging tab). */
export const Route = createFileRoute('/_authed/webhooks')({
  beforeLoad: () => {
    throw redirect({ to: '/' });
  },
});
