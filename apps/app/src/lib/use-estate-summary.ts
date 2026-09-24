import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';

/** One poll cadence for every estate number, so no two surfaces drift apart. */
const ESTATE_POLL_MS = 5_000;

export interface EstateSummary {
  nodes: { online: number; total: number };
  services: { running: number; total: number };
  containersRunning: number;
  recentDeployments: number;
  alerts: { firing: number; channels: number };
  incidents: { open: number };
}

export type EstateSummaryState =
  | { status: 'pending'; data: undefined; error: null }
  | { status: 'error'; data: undefined; error: unknown }
  | { status: 'ready'; data: EstateSummary; error: null };

/**
 * The single source of truth for the estate's headline numbers: nodes,
 * services, alerts firing, incidents open. The Overview KPIs, its headline and
 * attention card, the sidenav footer and the nav badges all read this one hook
 * — same queries, same cache entries, same cadence — so they can never
 * disagree. `status` is `pending` until every part has settled: callers draw a
 * skeleton, never a placeholder zero.
 */
export function useEstateSummary(): EstateSummaryState & { refetch: () => void; isFetching: boolean } {
  const trpc = useTRPC();
  const summary = useQuery({
    ...trpc.system.dashboardSummary.queryOptions(),
    refetchInterval: ESTATE_POLL_MS,
  });
  const alerts = useQuery({
    ...trpc.alerts.overview.queryOptions(),
    refetchInterval: ESTATE_POLL_MS,
  });
  const incidents = useQuery({
    ...trpc.incidents.overview.queryOptions(),
    refetchInterval: ESTATE_POLL_MS,
  });

  const parts = [summary, alerts, incidents];
  const refetch = (): void => {
    for (const p of parts) void p.refetch();
  };
  const isFetching = parts.some((p) => p.isFetching);

  if (summary.data && alerts.data && incidents.data) {
    return {
      status: 'ready',
      error: null,
      refetch,
      isFetching,
      data: {
        nodes: summary.data.nodes,
        services: summary.data.services,
        containersRunning: summary.data.containersRunning,
        recentDeployments: summary.data.recentDeployments,
        alerts: { firing: alerts.data.firing, channels: alerts.data.channels },
        incidents: { open: incidents.data.open },
      },
    };
  }
  const failed = parts.find((p) => p.isError);
  if (failed) return { status: 'error', data: undefined, error: failed.error, refetch, isFetching };
  return { status: 'pending', data: undefined, error: null, refetch, isFetching };
}
