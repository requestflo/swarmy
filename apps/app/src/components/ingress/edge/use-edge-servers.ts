import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NodeSummary } from '@swarmy/core';
import { toast } from '@swarmy/ui';
import { isNat } from '@/components/nodes/servers/fleet/fleet-model';
import { useTRPC } from '@/integrations/trpc';

/**
 * The servers and their edge switch. "Is an edge" is the node's role labels
 * (`nodes.setRole`): on = `swarmy.node.ingress` + `swarmy.node.outlet` (80/443
 * and, with geo-DNS, :53); off clears ingress, which drains both planes. NAT
 * comes from each server's `swarmy.node.reachability` label (`nodes.get`).
 */
export function useEdgeServers(targetNodes: string[], perNode: boolean) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const nodes = useQuery({ ...trpc.nodes.list.queryOptions(), refetchInterval: 15_000 });
  const details = useQueries({
    queries: (nodes.data ?? []).map((n) => ({ ...trpc.nodes.get.queryOptions({ id: n.id }), refetchInterval: 60_000 })),
  });
  const natIds = new Set(details.flatMap((d) => (d.data && isNat(d.data.labels) ? [d.data.id] : [])));
  const onError = (e: { message: string }): void => void toast.error(e.message);
  const done = (): void => void qc.invalidateQueries();
  const setRole = useMutation(trpc.nodes.setRole.mutationOptions({ onSuccess: done, onError }));
  const setTargets = useMutation(trpc.ingress.setTargetNodes.mutationOptions({ onSuccess: done, onError }));

  const rows: NodeSummary[] = nodes.data ?? [];
  const edges = rows.filter((n) => n.ingress);
  /** Switching off the last edge would leave an edge-per-node front door with nowhere to run. */
  const lastEdge = (id: string): boolean => perNode && edges.length === 1 && edges[0]!.id === id;

  const toggle = (n: NodeSummary, on: boolean): void => {
    setRole.mutate(on ? { id: n.id, ingress: true, outlet: true } : { id: n.id, ingress: false });
    // A single pin outranks the label tier: dropping this server keeps the one edge off it.
    if (!on && targetNodes.includes(n.id)) setTargets.mutate({ nodeIds: targetNodes.filter((x) => x !== n.id) });
  };

  return {
    nodes: nodes.data,
    error: nodes.error,
    natIds,
    lastEdge,
    toggle,
    clearPin: () => setTargets.mutate({ nodeIds: [] }),
    pending: setRole.isPending || setTargets.isPending,
  };
}
