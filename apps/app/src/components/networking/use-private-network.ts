import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { MeshDriverId } from './mesh-driver-card';

/** The private network page's data + mutations (moved out of the route, logic unchanged). */
export function usePrivateNetwork() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const config = useQuery(trpc.mesh.getConfig.queryOptions());
  const peers = useQuery({ ...trpc.mesh.listPeers.queryOptions(), refetchInterval: 10_000 });
  const nodes = useQuery(trpc.nodes.list.queryOptions());
  const driver = (config.data?.driver ?? 'none') as MeshDriverId;
  const live = !!config.data?.enabled && driver !== 'none';
  const managed = live && config.data?.controlPlaneMode === 'managed-by-swarmy';
  const people = useQuery({ ...trpc.mesh.people.connected.queryOptions(), enabled: managed, refetchInterval: 15_000 });

  const invalidate = (): void => void qc.invalidateQueries();
  const onError = (e: { message: string }): void => void toast.error(e.message);
  const setDriver = useMutation(trpc.mesh.setDriver.mutationOptions({ onSuccess: invalidate, onError }));
  // The server refuses turning the mesh off under servers that run the swarm
  // over it (they need a reinstall without --mesh first).
  const setEnabled = useMutation(trpc.mesh.setEnabled.mutationOptions({ onSuccess: invalidate, onError }));
  const enrollNode = useMutation(
    trpc.mesh.enrollNode.mutationOptions({
      onSuccess: () => {
        toast.success('Server joining the private network');
        invalidate();
      },
      onError,
    }),
  );
  const [enrollNodeId, setEnrollNodeId] = React.useState('');

  const peerRows = peers.data ?? [];
  const nodeRows = nodes.data ?? [];
  const onMesh = new Set(peerRows.map((p) => p.nodeId));
  const missing = nodeRows.filter((n) => !onMesh.has(n.id) && n.status !== 'offline');
  const laptops = (people.data ?? []).filter((p) => p.connected);
  return {
    ready: config.isSuccess && peers.isSuccess && nodes.isSuccess,
    error: config.error ?? peers.error,
    retry: () => void config.refetch(),
    config: config.data,
    driver,
    live,
    managed,
    peers: peerRows,
    nodes: nodeRows,
    missing,
    people: people.data ?? [],
    laptops,
    setDriver,
    setEnabled,
    enrollNode,
    enrollNodeId,
    setEnrollNodeId,
  };
}

export type PrivateNetwork = ReturnType<typeof usePrivateNetwork>;
