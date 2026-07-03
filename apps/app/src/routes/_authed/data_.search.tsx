import { createFileRoute, redirect } from '@tanstack/react-router';

/** Search now lives inside each stack workspace (the Data tab). */
export const Route = createFileRoute('/_authed/data_/search')({
  beforeLoad: () => {
    throw redirect({ to: '/' });
  },
});
