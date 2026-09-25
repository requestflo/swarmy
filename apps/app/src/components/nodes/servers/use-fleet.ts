import * as React from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { NodeStatsSnapshot, NodeSummary } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';

/** Disk use at which a server needs you (the agent's own hygiene trigger is 85%). */
export const DISK_HOT_PCT = 80;

export interface FleetServer {
  node: NodeSummary;
  /** Latest live sample (null when offline / not sampled yet). */
  live: NodeStatsSnapshot | null;
  diskPct: number | null;
  containers: number | null;
  monthlyUsd: number | null;
}

export interface Fleet {
  pending: boolean;
  servers: FleetServer[];
  /** The fullest server over DISK_HOT_PCT, if any. */
  hot: FleetServer | null;
  regions: number;
  cpus: number;
  memBytes: number;
  monthlyUsd: number;
}

/**
 * Every server with its live sample, container count and price — the one
 * source for the Servers list, the inspector and the headline's disk clause.
 */
export function useFleet(): Fleet {
  const trpc = useTRPC();
  const nodes = useQuery({ ...trpc.nodes.list.queryOptions(), refetchInterval: 5_000 });
  const costs = useQuery({ ...trpc.cost.overview.queryOptions(), refetchInterval: 30_000 });
  const counts = useQuery({ ...trpc.nodes.containerCounts.queryOptions(), refetchInterval: 5_000 });
  const list = nodes.data ?? [];
  const live = useQueries({
    queries: list.map((n) => ({
      ...trpc.nodes.liveStatsLatest.queryOptions({ nodeId: n.id }),
      refetchInterval: 5_000,
      enabled: n.status !== 'offline',
    })),
  });
  const liveData = live.map((q) => q.data ?? null);
  const liveKey = liveData.map((d) => `${d?.ts ?? 0}:${d?.fsUsedBytes ?? ''}`).join('|');

  return React.useMemo(() => {
    const price = new Map((costs.data?.nodes ?? []).map((c) => [c.nodeId, c.monthlyUsd]));
    const servers: FleetServer[] = list.map((node, i) => {
      const l = (liveData[i] ?? null) as NodeStatsSnapshot | null;
      const diskPct = l?.fsTotalBytes ? Math.round(((l.fsUsedBytes ?? 0) / l.fsTotalBytes) * 100) : null;
      return {
        node,
        live: l,
        diskPct,
        containers: counts.data?.[node.id] ?? null,
        monthlyUsd: price.get(node.id) ?? null,
      };
    });
    const hot =
      servers
        .filter((s) => s.diskPct !== null && s.diskPct >= DISK_HOT_PCT)
        .sort((a, b) => (b.diskPct ?? 0) - (a.diskPct ?? 0))[0] ?? null;
    return {
      pending: nodes.isPending,
      servers,
      hot,
      regions: new Set(list.map((n) => n.region).filter(Boolean)).size,
      cpus: list.reduce((a, n) => a + (n.resources.cpus ?? 0), 0),
      memBytes: list.reduce((a, n) => a + (n.resources.memBytes ?? 0), 0),
      monthlyUsd: servers.reduce((a, s) => a + (s.monthlyUsd ?? 0), 0),
    };
    // liveKey stands in for the per-query data identities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.data, nodes.isPending, costs.data, counts.data, liveKey]);
}
