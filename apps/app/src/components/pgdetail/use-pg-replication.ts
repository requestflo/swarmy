import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import type { PgDetailCluster } from './use-pg-detail';

/**
 * `db.replication`: each standby's replay LSN and lag, read on the main copy.
 * Only asked while there are standbys and the main copy runs (it is the one
 * that answers); every read is a `studio.query` audit row, so it polls at the
 * reconcile's own pace rather than faster.
 */
export function usePgReplication(stack: string, c: PgDetailCluster | null) {
  const trpc = useTRPC();
  const wanted = !!c && standbyCopies(c) > 0 && c.primary.status === 'running';
  const q = useQuery({
    ...trpc.db.replication.queryOptions({ stack, cluster: c?.name ?? '' }),
    enabled: wanted,
    refetchInterval: 15_000,
    retry: false,
  });
  return { wanted, view: q.data ?? null, pending: wanted && q.isPending, error: q.error };
}

/** Standby copies the cluster asks for, every region's included. */
export function standbyCopies(c: Pick<PgDetailCluster, 'members'>): number {
  return c.members.filter((m) => m.role === 'replica').reduce((n, m) => n + m.desired, 0);
}

export type PgReplicationData = ReturnType<typeof usePgReplication>;
