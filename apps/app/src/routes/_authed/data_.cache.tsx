import { createFileRoute, redirect } from '@tanstack/react-router';

/** Caches now live inside each stack workspace (the Data tab). */
export const Route = createFileRoute('/_authed/data_/cache')({
  beforeLoad: () => {
    throw redirect({ to: '/' });
  },
});
