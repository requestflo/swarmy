import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { usePgWindow } from './use-pg-window';

/**
 * Everything the Postgres backups section reads for one managed cluster:
 * the coverage row (schedule summary + the PITR window), the schedule label,
 * the restore points in the catalog, where they go, and the app's drills.
 * A wal-g PITR cluster's window and WAL check come from `usePgWindow`.
 * `from: 'copy'` reads the restore points (and the window) from the
 * schedule's second destination instead.
 */
export function usePgBackups(stack: string, cluster: string, from: PgSource = 'main') {
  const trpc = useTRPC();
  const overview = useQuery({ ...trpc.dbBackups.overview.queryOptions(), refetchInterval: 30_000 });
  const schedule = useQuery({ ...trpc.dbBackups.getSchedule.queryOptions({ stack, cluster }), refetchInterval: 30_000 });
  const targets = useQuery({ ...trpc.backups.listTargets.queryOptions(), refetchInterval: 10_000 });
  const hasTarget = (targets.data?.length ?? 0) > 0;
  const copyId = schedule.data?.secondaryTargetId ?? null;
  const fromCopy = from === 'copy' && copyId != null;
  const catalog = useQuery({
    ...trpc.dbBackups.list.queryOptions({ stack, cluster, ...(fromCopy ? { targetId: copyId } : {}) }),
    enabled: hasTarget,
    refetchInterval: 60_000,
  });
  const resilience = useQuery({ ...trpc.resilience.overview.queryOptions({ stack }), refetchInterval: 15_000 });
  const walg = schedule.data?.pitr === true && schedule.data.engine === 'wal-g';
  const row = (overview.data ?? []).find((r) => r.stack === stack && r.cluster === cluster) ?? null;
  const pitr = usePgWindow(stack, cluster, walg, row, fromCopy ? copyId : null);

  const s = schedule.data ?? null;
  // Same fallback as the service: the schedule's destination, else the oldest enabled one.
  const enabled = (targets.data ?? []).filter((t) => t.enabled).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const target = (targets.data ?? []).find((t) => t.id === (s?.targetId ?? row?.targetId)) ?? enabled[0] ?? null;
  const drill = resilience.data?.drills.find((d) => d.kind === 'restore') ?? null;

  return {
    pending: overview.isPending || schedule.isPending || targets.isPending,
    error: overview.error ?? schedule.error ?? null,
    row,
    /** The window the scrubber spans, where it came from, and whether this agent can read it at all. */
    pitrWindow: pitr.window,
    pitrWindowSource: pitr.source,
    pitrReadUnsupported: pitr.unsupported,
    /** The agent's WAL continuity read (wal-g PITR, main destination only). */
    walCheck: pitr.walCheck,
    schedule: s,
    target,
    /** The schedule's second destination ("also copy to"), and which one restores read from. */
    copyTarget: (targets.data ?? []).find((t) => t.id === copyId) ?? null,
    from: (fromCopy ? 'copy' : 'main') as PgSource,
    restoreTargetId: fromCopy ? copyId : undefined,
    hasTarget,
    catalog,
    points: catalog.data ?? [],
    drill,
    drillTargets: (resilience.data?.drillTargets ?? []).filter((t) => t.cluster === cluster),
  };
}

export type PgBackupsData = ReturnType<typeof usePgBackups>;
/** Where restores read from: the main destination or the second copy. */
export type PgSource = 'main' | 'copy';
