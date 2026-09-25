import { createFileRoute } from '@tanstack/react-router';
import { ServersPage } from '@/components/nodes/servers/servers-page';

/** Servers: the fleet, its one next action, and an inspector (components/nodes/servers). */
export const Route = createFileRoute('/_authed/nodes/')({
  component: ServersPage,
});
