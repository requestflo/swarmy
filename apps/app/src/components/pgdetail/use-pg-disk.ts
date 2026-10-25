import * as React from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { NodeStatsSnapshot } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { diskCopies, diskLine } from './pg-disk';
import type { PgDetailData } from './use-pg-detail';

/**
 * Each copy's data size and its server's free disk: the agents' volume
 * reports (`nodes.volumeSizes`, measured every 10 minutes) and the latest
 * live sample of each server a copy runs on (`nodes.liveStatsLatest`).
 */
export function usePgDisk(d: PgDetailData) {
  const trpc = useTRPC();
  const c = d.cluster;
  const sizes = useQuery({ ...trpc.nodes.volumeSizes.queryOptions(), enabled: !!c, refetchInterval: 60_000 });
  const servers = [...new Set((c?.members ?? []).flatMap((m) => (d.place?.get(m.service) ?? []).map((n) => n.id)))].sort();
  const live = useQueries({
    queries: servers.map((nodeId) => ({ ...trpc.nodes.liveStatsLatest.queryOptions({ nodeId }), refetchInterval: 30_000 })),
  });
  const key = live.map((q) => `${q.data?.ts ?? 0}`).join('|');
  return React.useMemo(() => {
    if (!c || sizes.isPending || !d.place) return { pending: true, line: null };
    const stats = new Map(servers.map((id, i) => [id, (live[i]?.data ?? null) as NodeStatsSnapshot | null]));
    return { pending: false, line: diskLine(diskCopies(c.members, d.place, sizes.data ?? [], stats)) };
    // `key` stands in for the per-server query identities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c, d.place, sizes.data, sizes.isPending, key]);
}
