import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { NodeDetail } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { useRolling } from '@/components/charts';
import type { NodeContainer } from '../node-containers-panel';
import type { FleetServer } from '../servers/use-fleet';

export interface ServerState {
  pending: boolean;
  error: unknown;
  node: NodeDetail | undefined;
  /** The same shape the Servers inspector reads; null until the node lands. */
  server: FleetServer | null;
  containers: NodeContainer[] | undefined;
  trend: { t: string; cpu: number; mem: number }[];
  refetch: () => void;
}

/** One server's live picture: the node, its latest sample, what runs there, its price. */
export function useServer(nodeId: string): ServerState {
  const trpc = useTRPC();
  const node = useQuery({ ...trpc.nodes.get.queryOptions({ id: nodeId }), refetchInterval: 5_000 });
  const live = useQuery({ ...trpc.nodes.liveStatsLatest.queryOptions({ nodeId }), refetchInterval: 2_000 });
  const containers = useQuery({ ...trpc.nodes.containers.queryOptions({ nodeId }), refetchInterval: 5_000 });
  const costs = useQuery({ ...trpc.cost.overview.queryOptions(), refetchInterval: 30_000 });

  const point = React.useMemo(
    () =>
      live.data
        ? {
            t: new Date().toLocaleTimeString(),
            cpu: Number(live.data.cpuPercent.toFixed(1)),
            mem: live.data.memTotalBytes ? Number(((live.data.memUsedBytes / live.data.memTotalBytes) * 100).toFixed(1)) : 0,
          }
        : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [live.dataUpdatedAt, live.data],
  );
  const trend = useRolling(point, 60);

  const n = node.data ?? undefined;
  const l = live.data ?? null;
  const list = containers.data as NodeContainer[] | undefined;
  const server: FleetServer | null = n
    ? {
        node: n,
        live: l,
        diskPct: l?.fsTotalBytes ? Math.round(((l.fsUsedBytes ?? 0) / l.fsTotalBytes) * 100) : null,
        containers: list ? list.length : null,
        monthlyUsd: costs.data?.nodes.find((c) => c.nodeId === nodeId)?.monthlyUsd ?? null,
      }
    : null;
  return {
    pending: node.isPending,
    error: node.error,
    node: n,
    server,
    containers: list,
    trend,
    refetch: () => void node.refetch(),
  };
}
