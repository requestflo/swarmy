import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowRightIcon, HardDriveIcon } from 'lucide-react';
import { Button, Card, CardContent, EmptyState } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { StackResilienceSection } from '@/components/resilience/stack-resilience-section';
import { ErrorState } from '@/components/states';
import { StackDbCoverageCard } from './stack-db-coverage-card';
import { StackVolumeCoverageCard } from './stack-volume-coverage-card';
import { StackDrHero } from './stack-dr-hero';
import { StackSchedulesCard } from './stack-schedules-card';
import { StackSnapshotsCard } from './stack-snapshots-card';

interface StackBackupsProps {
  stack: string;
}

/**
 * The Backups tab of the stack workspace: this stack's DR posture, its
 * schedules, its snapshot catalog, and its resilience score + drills.
 * Destinations themselves are managed estate-wide at /backups.
 */
export function StackBackups({ stack }: StackBackupsProps): React.JSX.Element {
  const trpc = useTRPC();
  const targets = useQuery({ ...trpc.backups.listTargets.queryOptions(), refetchInterval: 10_000 });
  const schedules = useQuery({
    ...trpc.backupSchedules.list.queryOptions({ stack }),
    refetchInterval: 5_000,
  });
  const snapshots = useQuery({
    ...trpc.backups.listSnapshots.queryOptions({ stack }),
    refetchInterval: 5_000,
  });
  const coverage = useQuery({
    ...trpc.backups.autoCoverage.queryOptions({ stack }),
    refetchInterval: 15_000,
  });
  const [creating, setCreating] = React.useState(false);
  const [prefillVolume, setPrefillVolume] = React.useState<string | undefined>(undefined);
  const changeVolume = React.useCallback((volume: string) => {
    setPrefillVolume(volume);
    setCreating(true);
  }, []);

  const targetRows = targets.data ?? [];
  const targetOptions = React.useMemo(
    () => targetRows.map((t) => ({ id: t.id, name: t.name })),
    [targetRows],
  );
  const scheduleRows = schedules.data ?? [];
  const snapshotRows = snapshots.data ?? [];

  const nextRunAt = React.useMemo(() => {
    const upcoming = scheduleRows
      .filter((s) => !s.paused && s.nextRunAt)
      .map((s) => s.nextRunAt as string)
      .sort();
    return upcoming[0] ?? null;
  }, [scheduleRows]);

  const lastSnapshot = snapshotRows[0] ?? null;
  const targetName =
    lastSnapshot?.targetName ||
    targetOptions.find((t) => t.id === scheduleRows[0]?.targetId)?.name ||
    targetOptions[0]?.name ||
    null;

  // The hero is a claim about coverage — draw nothing until every input has
  // settled, so "no backups yet" can never flash over a covered stack.
  if (targets.isPending || schedules.isPending || snapshots.isPending) {
    return (
      <div className="grid gap-6">
        <div className="calm-card shimmer-line h-32" />
        <div className="calm-card shimmer-line h-48" />
      </div>
    );
  }
  if (targets.isError) {
    return (
      <ErrorState
        title="Couldn’t load backup destinations."
        error={targets.error}
        retry={() => void targets.refetch()}
        retrying={targets.isFetching}
      />
    );
  }

  if (targetOptions.length === 0) {
    const dbCount = coverage.data?.databases.length ?? 0;
    return (
      <div className="calm-card p-2">
        <EmptyState
          icon={<HardDriveIcon />}
          title={dbCount > 0 ? 'Backups are off — add a destination' : 'No backup destinations yet'}
          description={
            dbCount > 0
              ? `${stack} has ${dbCount} database${dbCount === 1 ? '' : 's'} that back up nightly, automatically, as soon as a destination exists — swarmy object storage, an S3 bucket, or a node path.`
              : "Add an S3 bucket, a node path, or use swarmy object storage — then schedule this stack's volumes here."
          }
          action={
            <Button variant="outline" asChild className="rounded-full font-bold">
              <Link to="/backups">
                Set up a destination <ArrowRightIcon className="size-4" />
              </Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      <StackDrHero
        stack={stack}
        lastBackupAt={lastSnapshot?.startedAt ?? null}
        nextRunAt={nextRunAt}
        targetName={targetName}
        snapshotCount={snapshotRows.length}
        activeScheduleCount={scheduleRows.filter((s) => !s.paused).length}
      />

      <Card className="calm-card">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
          <p className="text-muted-foreground text-sm">
            Destinations are managed estate-wide.
          </p>
          <Link
            to="/backups"
            className="text-primary flex items-center gap-1 text-sm font-bold hover:underline"
          >
            Backup destinations <ArrowRightIcon className="size-4" />
          </Link>
        </CardContent>
      </Card>

      {coverage.data && (
        <StackDbCoverageCard stack={stack} coverage={coverage.data} onChangeVolume={changeVolume} />
      )}
      {coverage.data?.volumes && (
        <StackVolumeCoverageCard
          stack={stack}
          volumes={coverage.data.volumes}
          appOptedOut={coverage.data.appOptedOut ?? false}
        />
      )}
      <StackSchedulesCard
        stack={stack}
        schedules={scheduleRows}
        targets={targetOptions}
        creating={creating}
        onCreatingChange={(open) => {
          setCreating(open);
          if (!open) setPrefillVolume(undefined);
        }}
        prefillVolume={prefillVolume}
        onChangeAuto={changeVolume}
      />
      <StackSnapshotsCard stack={stack} snapshots={snapshotRows} targets={targetOptions} />
      <StackResilienceSection stack={stack} />
    </div>
  );
}
