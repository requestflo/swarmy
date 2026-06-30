import * as React from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { CalendarClockIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { CountUp } from '@/components/count-up';
import { BackupVolumeDialog } from '@/components/backups/backup-volume-dialog';
import { TargetsCard } from '@/components/backups/targets-card';
import { SnapshotsList } from '@/components/backups/snapshots-list';
import { DbBackupsCard } from '@/components/backups/db-backups-card';

export const Route = createFileRoute('/_authed/backups')({
  component: BackupsPage,
});

function BackupsPage(): React.JSX.Element {
  const trpc = useTRPC();
  const targets = useQuery(trpc.backups.listTargets.queryOptions());
  const snapshots = useQuery(trpc.backups.listSnapshots.queryOptions({}));

  const targetRows = targets.data ?? [];
  const snapCount = snapshots.data?.length ?? 0;

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Backups"
        title={
          snapCount > 0 ? (
            <>
              <CountUp value={snapCount} /> snapshot{snapCount === 1 ? '' : 's'} <em>safe</em>.
            </>
          ) : (
            <>
              Never lose <em>your</em> data.
            </>
          )
        }
        description="Encrypted, deduplicated restic snapshots of your volumes — to any S3 target. Restore to any node, any time."
        actions={
          <>
            <Button asChild variant="ghost" className="rounded-full">
              <Link to="/backups/schedules">
                <CalendarClockIcon className="size-4" /> Schedules
              </Link>
            </Button>
            <BackupVolumeDialog targets={targetRows} />
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <TargetsCard targets={targetRows} />
        <SnapshotsList />
      </div>

      <div className="mt-6">
        <DbBackupsCard />
      </div>
    </div>
  );
}
