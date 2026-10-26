import { useQuery } from '@tanstack/react-query';
import type { RollbackTimingView } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';

/**
 * The latest measured rollback (`releases.lastRollback`): this app's when it
 * has one, else the estate's. Undefined while loading, null when none was
 * measured yet. `pollMs` while waiting for one in flight to settle.
 */
export function useLastRollback(app: string | null, pollMs = 60_000): RollbackTimingView | null | undefined {
  const trpc = useTRPC();
  const mine = useQuery({ ...trpc.releases.lastRollback.queryOptions(app ? { stackName: app } : {}), enabled: app !== null, refetchInterval: pollMs });
  const any = useQuery({ ...trpc.releases.lastRollback.queryOptions({}), refetchInterval: pollMs });
  if ((app !== null && mine.isPending) || any.isPending) return undefined;
  return (app !== null ? mine.data : null) ?? any.data ?? null;
}
