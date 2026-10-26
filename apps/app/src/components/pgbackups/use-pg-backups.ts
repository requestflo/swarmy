import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { pickPitrWindow } from './pitr-scrub';

/**
 * Everything the Postgres backups section reads for one managed cluster:
 * the coverage row (schedule summary + the PITR window), the schedule label,
 * the restore points in the catalog, where they go, and the app's drills.
 * For a wal-g PITR cluster the window is the agent's read of the WAL repo
 * (`dbBackups.pitrWindow`, a sidecar run, so read sparingly) when it can, and
 * `dbBackups.walCheck` says whether that archive has a gap.
 */
export function usePgBackups(stack: string, cluster: string) {
  const trpc = useTRPC();
  const overview = useQuery({ ...trpc.dbBackups.overview.queryOptions(), refetchInterval: 30_000 });
  const schedule = useQuery({ ...trpc.dbBackups.getSchedule.queryOptions({ stack, cluster }), refetchInterval: 30_000 });
  const targets = useQuery({ ...trpc.backups.listTargets.queryOptions(), refetchInterval: 10_000 });
  const hasTarget = (targets.data?.length ?? 0) > 0;
  const catalog = useQuery({
    ...trpc.dbBackups.list.queryOptions({ stack, cluster }),
    enabled: hasTarget,
    refetchInterval: 60_000,
  });
  const resilience = useQuery({ ...trpc.resilience.overview.queryOptions({ stack }), refetchInterval: 15_000 });
  const walg = schedule.data?.pitr === true && schedule.data.engine === 'wal-g';
  const read = useQuery({
    ...trpc.dbBackups.pitrWindow.queryOptions({ stack, cluster }),
    enabled: walg,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: false,
  });
  // Is the WAL archive continuous? (`wal-g wal-verify`, also a sidecar; the controller reuses a fresh read.)
  const wal = useQuery({
    ...trpc.dbBackups.walCheck.queryOptions({ stack, cluster }),
    enabled: walg,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: false,
  });

  const rows = overview.data ?? [];
  const row = rows.find((r) => r.stack === stack && r.cluster === cluster) ?? null;
  const s = schedule.data ?? null;
  // Same fallback as the service: the schedule's destination, else the oldest enabled one.
  const enabled = (targets.data ?? []).filter((t) => t.enabled).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const target = (targets.data ?? []).find((t) => t.id === (s?.targetId ?? row?.targetId)) ?? enabled[0] ?? null;
  const drill = resilience.data?.drills.find((d) => d.kind === 'restore') ?? null;
  const pitr = pickPitrWindow(walg ? read.data : null, row);

  return {
    pending: overview.isPending || schedule.isPending || targets.isPending,
    error: overview.error ?? schedule.error ?? null,
    row,
    /** The window the scrubber spans, where it came from, and whether this agent can read it at all. */
    pitrWindow: pitr.window,
    pitrWindowSource: pitr.source,
    pitrReadUnsupported: walg && read.data?.source === 'unsupported',
    /** The agent's WAL continuity read (wal-g PITR only). */
    walCheck: walg ? (wal.data ?? null) : null,
    schedule: s,
    target,
    hasTarget,
    catalog,
    points: catalog.data ?? [],
    drill,
    drillTargets: (resilience.data?.drillTargets ?? []).filter((t) => t.cluster === cluster),
  };
}

export type PgBackupsData = ReturnType<typeof usePgBackups>;
