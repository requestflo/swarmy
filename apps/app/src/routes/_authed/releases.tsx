import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * The old global Releases surface moved into the stack workspace — each
 * stack's history lives at /stacks/$name/releases. Send visitors home.
 */
export const Route = createFileRoute('/_authed/releases')({
  beforeLoad: () => {
    throw redirect({ to: '/' });
  },
});
