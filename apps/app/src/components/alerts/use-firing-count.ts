import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';

/**
 * Live count of firing alert events — powers the shell bell badge (wired in
 * Wave G) and anything else that wants a cheap "is something on fire?" signal.
 */
export function useFiringCount(): { firing: number; critical: number } {
  const trpc = useTRPC();
  const overview = useQuery({
    ...trpc.alerts.overview.queryOptions(),
    refetchInterval: 15_000,
  });
  return {
    firing: overview.data?.firing ?? 0,
    critical: overview.data?.firingCritical ?? 0,
  };
}
