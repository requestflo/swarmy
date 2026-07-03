import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * The old stacks index dissolved into the stack-first IA: the estate rollup
 * lives on Overview, compose deploys at /stacks/new, and each stack is its own
 * workspace at /stacks/$name (databases live in its Data tab).
 */
export const Route = createFileRoute('/_authed/stacks/')({
  beforeLoad: () => {
    throw redirect({ to: '/' });
  },
});
