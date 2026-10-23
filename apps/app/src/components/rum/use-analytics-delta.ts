import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { kpiDelta, type KpiDelta } from './analytics-delta';
import type { AnalyticsView } from './rum-shared';

/**
 * KPI deltas against the previous window: a second `rum.analytics` read over
 * twice the days. Asked only when the data could exist — the double window
 * fits the query's 90-day limit and the app keeps events that long — so a
 * short retention never reads as a drop.
 */
export function useAnalyticsDelta(
  stack: string,
  days: number,
  retentionDays: number | undefined,
  current: AnalyticsView | undefined,
): KpiDelta | null {
  const trpc = useTRPC();
  const span = days * 2;
  const askable = span <= 90 && (retentionDays ?? 0) >= span && current?.status === 'ok';
  const both = useQuery({
    ...trpc.rum.analytics.queryOptions({ stack, days: span }),
    enabled: askable,
    refetchInterval: 60_000,
  });
  if (!askable || !current || both.data?.status !== 'ok') return null;
  return kpiDelta(current.kpis, both.data.kpis);
}
