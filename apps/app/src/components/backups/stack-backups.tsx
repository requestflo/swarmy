import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowRightIcon, HardDriveIcon } from 'lucide-react';
import { Button, Card, CardContent, EmptyState } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { StackResilienceSection } from '@/components/resilience/stack-resilience-section';
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
    ...trpc.schedules.list.queryOptions({ stack }),
    refetchInterval: 5_000,
  });
  const snapshots = useQuery({
    ...trpc.backups.listSnapshots.queryOptions({ stack }),
    refetchInterval: 5_000,
  });

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

  if (targets.isLoading) {
    return (
      <div className="grid gap-6">
        <div className="card-pop shimmer-line h-32" />
        <div className="card-pop shimmer-line h-48" />
      </div>
    );
  }

  if (targetOptions.length === 0) {
    return (
      <div className="card-pop p-2">
        <EmptyState
          icon={<HardDriveIcon />}
          title="No backup destinations yet"
          description="Add an S3 bucket, a node path, or use swarmy object storage — then schedule this stack's volumes here."
          action={
            <Button asChild className="rounded-full font-bold">
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
      />

      <Card className="card-pop border-0">
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

      <StackSchedulesCard stack={stack} schedules={scheduleRows} targets={targetOptions} />
      <StackSnapshotsCard stack={stack} snapshots={snapshotRows} targets={targetOptions} />
      <StackResilienceSection stack={stack} />
    </div>
  );
}
