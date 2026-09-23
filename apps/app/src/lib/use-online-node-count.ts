import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';

/**
 * How many nodes are online right now — `undefined` until the nodes list has
 * loaded. Drives capacity-aware defaults (a DB replica can never schedule on
 * a 1-node swarm: replicas are anti-affine to the primary).
 */
export function useOnlineNodeCount(): number | undefined {
  const trpc = useTRPC();
  const nodes = useQuery(trpc.nodes.list.queryOptions());
  if (!nodes.data) return undefined;
  return nodes.data.filter((n) => n.status === 'online').length;
}
