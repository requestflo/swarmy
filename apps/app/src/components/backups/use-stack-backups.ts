import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';

/** One app's backups: destinations, schedules, restore points and default-on coverage (moved from the tab, unchanged). */
export function useStackBackups(stack: string) {
  const trpc = useTRPC();
  const targets = useQuery({ ...trpc.backups.listTargets.queryOptions(), refetchInterval: 10_000 });
  const schedules = useQuery({ ...trpc.backupSchedules.list.queryOptions({ stack }), refetchInterval: 5_000 });
  const snapshots = useQuery({ ...trpc.backups.listSnapshots.queryOptions({ stack }), refetchInterval: 5_000 });
  const coverage = useQuery({ ...trpc.backups.autoCoverage.queryOptions({ stack }), refetchInterval: 15_000 });

  const targetRows = targets.data ?? [];
  const targetOptions = React.useMemo(() => targetRows.map((t) => ({ id: t.id, name: t.name })), [targetRows]);
  const scheduleRows = schedules.data ?? [];
  const snapshotRows = snapshots.data ?? [];
  const c = coverage.data;
  const items = [...(c?.databases ?? []), ...(c?.volumes ?? [])];
  const covered = items.filter((i) => i.status === 'auto' || i.status === 'user').length;
  const uncovered = items.filter((i) => i.status === 'unscheduled');
  const optedOut = items.filter((i) => i.status === 'opted-out').length;
  const last = snapshotRows.find((s) => s.status === 'SUCCEEDED') ?? null;
  const failed = snapshotRows[0]?.status === 'FAILED' ? snapshotRows[0] : null;
  const destination = c?.destination?.name ?? last?.targetName ?? targetOptions[0]?.name ?? null;

  return {
    // The header is a claim about coverage: nothing until every input settled.
    pending: targets.isPending || schedules.isPending || snapshots.isPending || coverage.isPending,
    targets,
    coverage: c,
    targetOptions,
    scheduleRows,
    snapshotRows,
    total: items.length,
    covered,
    uncovered,
    optedOut,
    last,
    failed,
    destination,
  };
}

export type StackBackupsData = ReturnType<typeof useStackBackups>;
