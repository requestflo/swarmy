import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';

const DAY = 86_400_000;

/**
 * The issue's 24 hourly event counts. `errors.issue` may carry them; the
 * controller fills `trend` on the issues list, so otherwise read it from there
 * (sorted by last seen, so any issue with events in the last day is near the
 * top). An issue last seen over a day ago had no events in the window: zeros.
 * Null while unknown — the chart waits rather than drawing a fake flat line.
 */
export function useIssueTrend(stack: string, fingerprint: string, own: number[], lastSeen: string | null): number[] | null {
  const trpc = useTRPC();
  const need = own.length === 0;
  const list = useQuery({ ...trpc.errors.issues.queryOptions({ stack, status: 'all', sort: 'last_seen', limit: 200 }), enabled: need });
  if (!need) return own;
  const hit = list.data?.issues.find((i) => i.fingerprint === fingerprint);
  if (hit?.trend.length) return hit.trend;
  const quiet = lastSeen !== null && Date.now() - Date.parse(lastSeen) > DAY;
  return list.data && quiet ? new Array<number>(24).fill(0) : null;
}
