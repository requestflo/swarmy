import * as React from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { DbBackupOverviewRow, DbBackupSnapshotView, ReleaseView } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import type { SnapshotLike } from '@/components/estate-map/rewind-ticks';
import { travelEvents, type TravelEvent } from './time-travel-model';
import { useAppIncidents } from './use-app-incidents';

/** A clock for the timeline's "now" end: ticks once a minute. */
function useMinuteClock(): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** One managed database of the app and its saves (undefined while they load). */
export interface AppDatabase {
  row: DbBackupOverviewRow;
  saves: DbBackupSnapshotView[] | undefined;
}

export interface TimeTravelData {
  now: number;
  /** Every input the timeline needs has settled (a lane never shows a fake gap). */
  ready: boolean;
  /** Some backups or incidents couldn't be read: those lanes may be missing events. */
  partial: boolean;
  error: unknown;
  releases: ReleaseView[];
  events: TravelEvent[];
  databases: AppDatabase[];
  /** The app's volume saves (`backups.listSnapshots`, newest first). */
  snapshots: SnapshotLike[];
}

/** One app's week: releases, its incidents, volume backups and managed-database saves. */
export function useTimeTravel(stack: string): TimeTravelData {
  const trpc = useTRPC();
  const now = useMinuteClock();
  const releases = useQuery({ ...trpc.releases.list.queryOptions({ stackName: stack, limit: 100 }), refetchInterval: 30_000 });
  const snaps = useQuery({ ...trpc.backups.listSnapshots.queryOptions({ stack }), refetchInterval: 60_000 });
  const overview = useQuery({ ...trpc.dbBackups.overview.queryOptions(), refetchInterval: 60_000 });
  const incidents = useAppIncidents(stack, now);
  const rows = React.useMemo(() => (overview.data ?? []).filter((r) => r.stack === stack), [overview.data, stack]);
  const saves = useQueries({
    queries: rows.map((r) => ({ ...trpc.dbBackups.list.queryOptions({ stack, cluster: r.cluster }), refetchInterval: 60_000 })),
  });

  // A lane that failed to load settles empty and says so (`partial`); releases are required.
  const lanes = [snaps, overview, ...saves];
  const partial = lanes.some((q) => q.isError) || incidents.isError;
  const ready = Boolean(releases.data) && lanes.every((q) => q.data || q.isError) && (Boolean(incidents.data) || incidents.isError);
  // A week of events is a few dozen rows: cheap enough to rebuild each render.
  const events = ready
    ? travelEvents({ releases: releases.data, incidents: incidents.data, snapshots: snaps.data, dbBackups: saves.flatMap((s) => s.data ?? []), now })
    : [];
  return {
    now,
    ready,
    partial,
    error: releases.error ?? null,
    releases: releases.data ?? [],
    events,
    databases: rows.map((row, i) => ({ row, saves: saves[i]?.data })),
    snapshots: snaps.data ?? [],
  };
}
