import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '@/components/page-header';
import { BackupNowButton } from '@/components/controllerbackup/backup-now-button';
import { DataStoreCard } from '@/components/controllerbackup/data-store-card';
import { PassphraseCard } from '@/components/controllerbackup/passphrase-card';
import { ScheduleCard } from '@/components/controllerbackup/schedule-card';
import { SnapshotsList } from '@/components/controllerbackup/snapshots-list';

export const Route = createFileRoute('/_authed/settings/backup')({
  component: ControllerBackupPage,
});

function ControllerBackupPage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Controller backup"
        title={
          <>
            Protect the <em>brain</em>.
          </>
        }
        description="The controller database is swarmy's control plane — orgs, nodes, join-token hashes, ingress, deployments. Back it up so a rebuilt controller can re-adopt the whole swarm."
        actions={<BackupNowButton />}
      />
      <div className="grid gap-6">
        <DataStoreCard />
        <PassphraseCard />
        <ScheduleCard />
        <SnapshotsList />
      </div>
    </div>
  );
}
