import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import type { MeshLinkLike } from './mesh-link-words';

/**
 * `mesh.links`: every server-to-server link some end reported, with each
 * end's latency, path and bytes (agents send them every 20 s). `undefined`
 * while loading; a link no end reported is simply absent ("not reported").
 */
export function useMeshLinks(enabled = true, refetchInterval = 20_000): MeshLinkLike[] | undefined {
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.mesh.links.queryOptions(), enabled, refetchInterval });
  return q.data;
}
