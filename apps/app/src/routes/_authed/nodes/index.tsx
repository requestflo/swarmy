import { createFileRoute } from '@tanstack/react-router';
import { InfrastructurePlane } from '@/components/infra/infrastructure-plane';

/**
 * The Infrastructure plane — the cluster: live health + a grid of node cards.
 * (Absorbs the former Overview KPIs; the home `/` is now the Applications canvas.)
 */
export const Route = createFileRoute('/_authed/nodes/')({
  component: InfrastructurePlane,
});
