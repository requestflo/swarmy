import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import type { BadgeKey } from '@/lib/destinations';

/**
 * Live attention counts for the sidenav badges. One cheap poll per signal;
 * every count fails safe to 0 so a missing/disabled backend never breaks the
 * shell. Keyed by {@link BadgeKey} so a nav item just names the signal it wants.
 */
export function useNavBadges(): Record<BadgeKey, number> {
  const trpc = useTRPC();

  const summary = useQuery({
    ...trpc.system.dashboardSummary.queryOptions(),
    refetchInterval: 10_000,
  });
  const alerts = useQuery({
    ...trpc.alerts.overview.queryOptions(),
    refetchInterval: 15_000,
  });
  const incidents = useQuery({
    ...trpc.incidents.overview.queryOptions(),
    refetchInterval: 15_000,
  });

  const nodes = summary.data?.nodes;
  const nodesOffline = nodes ? Math.max(0, nodes.total - nodes.online) : 0;

  return {
    nodesOffline,
    alertsFiring: alerts.data?.firing ?? 0,
    incidentsOpen: incidents.data?.open ?? 0,
  };
}
