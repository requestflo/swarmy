import type { BadgeKey } from '@/lib/destinations';
import { useEstateSummary } from '@/lib/use-estate-summary';

/**
 * Live attention counts for the sidenav badges, read from the one estate
 * summary (so a badge never disagrees with the Overview). Every count fails
 * safe to 0 while loading or when a backend is missing, so the shell itself
 * never breaks. Keyed by {@link BadgeKey} so a nav item just names the signal.
 */
export function useNavBadges(): Record<BadgeKey, number> {
  const estate = useEstateSummary();
  if (estate.status !== 'ready') return { nodesOffline: 0, alertsFiring: 0, incidentsOpen: 0 };
  const { nodes, alerts, incidents } = estate.data;
  return {
    nodesOffline: Math.max(0, nodes.total - nodes.online),
    alertsFiring: alerts.firing,
    incidentsOpen: incidents.open,
  };
}
