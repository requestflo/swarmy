import { createFileRoute, redirect } from '@tanstack/react-router';

/** Vector stores now live inside each stack workspace (the Data tab). */
export const Route = createFileRoute('/_authed/data_/vector')({
  beforeLoad: () => {
    throw redirect({ to: '/' });
  },
});
