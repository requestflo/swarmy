import { createFileRoute, redirect } from '@tanstack/react-router';
import { legacyStackTarget } from '@/lib/stack-nav-match';

/** Old flat Settings tab → Config › Scaling (2026-09-26, the board 9-tab IA). */
export const Route = createFileRoute('/_authed/stacks/$name/settings')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: legacyStackTarget('settings')!, params: { name: params.name }, replace: true });
  },
});
