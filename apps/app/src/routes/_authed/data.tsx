import { createFileRoute, redirect } from '@tanstack/react-router';

/** Data services now live inside each stack workspace (the Data tab). */
export const Route = createFileRoute('/_authed/data')({
  beforeLoad: () => {
    throw redirect({ to: '/' });
  },
});
