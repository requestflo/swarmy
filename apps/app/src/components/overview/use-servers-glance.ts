import { useQueries, useQuery } from '@tanstack/react-query';
import type { NodeStatsSnapshot, NodeSummary } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';

export interface ServerGlance {
  node: NodeSummary;
  cpu: number | null;
  mem: number | null;
  disk: number | null;
}

function pct(used: number | null | undefined, total: number | null | undefined): number | null {
  return used != null && total ? Math.round((used / total) * 100) : null;
}

/** Every server with its latest CPU / memory / disk use (null until sampled, or when offline). */
export function useServersGlance(): { pending: boolean; servers: ServerGlance[]; nodes: NodeSummary[] } {
  const trpc = useTRPC();
  const nodes = useQuery({ ...trpc.nodes.list.queryOptions(), refetchInterval: 5_000 });
  const list = nodes.data ?? [];
  const live = useQueries({
    queries: list.map((n) => ({
      ...trpc.nodes.liveStatsLatest.queryOptions({ nodeId: n.id }),
      refetchInterval: 5_000,
      enabled: n.status !== 'offline',
    })),
  });
  const servers = list.map((node, i) => {
    const l = (live[i]?.data ?? null) as NodeStatsSnapshot | null;
    return {
      node,
      cpu: l ? Math.round(l.cpuPercent) : node.live ? Math.round(node.live.cpuPercent) : null,
      mem: pct(l?.memUsedBytes, l?.memTotalBytes) ?? (node.live ? Math.round(node.live.memPercent) : null),
      disk: pct(l?.fsUsedBytes, l?.fsTotalBytes),
    };
  });
  return { pending: nodes.isPending, servers, nodes: list };
}
