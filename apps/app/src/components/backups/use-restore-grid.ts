import { useQueries, useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { controllerLane, dbLanes, orderLanes, volumeLanes } from './restore-grid-lanes';
import { lastNight, nightStarts } from './restore-grid-model';

/**
 * The estate's restore points as lanes × nights: volume snapshots, each
 * destination's database dumps, and swarmy's own bundle.
 */
export function useRestoreGrid() {
  const trpc = useTRPC();
  const targets = useQuery({ ...trpc.backups.listTargets.queryOptions(), refetchInterval: 5_000 });
  const volumes = useQuery({ ...trpc.backups.listSnapshots.queryOptions({}), refetchInterval: 5_000 });
  const controller = useQuery({ ...trpc.controllerBackup.listSnapshots.queryOptions(), refetchInterval: 30_000 });
  // Oldest first: the first is the default destination, so a dump listed twice keeps its home.
  const enabled = (targets.data ?? []).filter((t) => t.enabled).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const catalogs = useQueries({
    queries: enabled.map((t) => ({ ...trpc.dbBackups.list.queryOptions({ targetId: t.id }), refetchInterval: 60_000 })),
  });

  const nowMs = Date.now();
  const starts = nightStarts(nowMs);
  const name = (id: string): string | null => targets.data?.find((t) => t.id === id)?.name ?? null;
  const ctl = controllerLane(controller.data ?? [], name, starts);
  const lanes = orderLanes([
    ...volumeLanes(volumes.data ?? [], starts),
    ...dbLanes(
      enabled.map((t, i) => ({ where: t.name, whereId: t.id, snaps: catalogs[i]?.data ?? [] })),
      starts,
    ),
    ...(ctl ? [ctl] : []),
  ]);

  return {
    pending: targets.isPending || volumes.isPending,
    /** Every list has answered (or failed): only then is a count a claim. */
    settled: !targets.isPending && !volumes.isPending && !controller.isPending && catalogs.every((q) => !q.isPending),
    error: volumes.error,
    lanes,
    starts,
    lastNight: lastNight(lanes, nowMs),
    /** A destination's database list failed: say so rather than show a gap as "not saved". */
    catalogErrors: catalogs.flatMap((q, i) => (q.error ? [`${enabled[i]?.name}: ${q.error.message}`] : [])),
  };
}

export type RestoreGridData = ReturnType<typeof useRestoreGrid>;
