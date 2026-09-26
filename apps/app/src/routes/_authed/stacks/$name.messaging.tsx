import { createFileRoute, redirect } from '@tanstack/react-router';
import { legacyStackTarget } from '@/lib/stack-nav-match';

/**
 * Old Jobs & queues tab → Config › Jobs & previews; a queue anchor in the old
 * URL (`#queues`) lands on Data › Queues (2026-09-26, the board 9-tab IA).
 */
export const Route = createFileRoute('/_authed/stacks/$name/messaging')({
  beforeLoad: ({ params, location }) => {
    throw redirect({ to: legacyStackTarget('messaging', location.hash)!, params: { name: params.name }, replace: true });
  },
});
