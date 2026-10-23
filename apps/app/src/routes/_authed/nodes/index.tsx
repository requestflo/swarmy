import { createFileRoute } from '@tanstack/react-router';
import { ServersPage } from '@/components/nodes/servers/servers-page';

/** Servers: the fleet, its one next action, and an inspector (components/nodes/servers). */
export const Route = createFileRoute('/_authed/nodes/')({
  /** `?move=<service id>` opens the move picker for it (Placement & volumes' "Move…"). */
  validateSearch: (search: Record<string, unknown>): { move?: string } => (typeof search.move === 'string' ? { move: search.move } : {}),
  component: ServersPage,
});
