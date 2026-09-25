import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { SectionHeader } from '@/components/section-header';
import { CountUp } from '@/components/count-up';
import { NativeTargetHero } from '@/components/backups/native-target-hero';
import { DestinationsCard } from '@/components/backups/destinations-card';
import { EstateSnapshotsCard } from '@/components/backups/estate-snapshots-card';
import { ReplicatedStorePanel } from '@/components/backups/replicated-store-panel';
import { BackupNowButton } from '@/components/controllerbackup/backup-now-button';
import { ReplicationCard } from '@/components/controllerbackup/replication-card';
import { PassphraseCard } from '@/components/controllerbackup/passphrase-card';
import { ScheduleCard } from '@/components/controllerbackup/schedule-card';
import { SnapshotsList } from '@/components/controllerbackup/snapshots-list';

/**
 * The one Backups page: where backups go (destinations — what gets backed up
 * lives in each stack's Backups tab), then "swarmy itself" — the controller's
 * own replica and recovery bundle.
 */
export const Route = createFileRoute('/_authed/backups')({
  component: BackupsPage,
});

function BackupsPage(): React.JSX.Element {
  const trpc = useTRPC();
  const targets = useQuery({
    ...trpc.backups.listTargets.queryOptions(),
    refetchInterval: 5_000,
  });
  const targetRows = targets.data ?? [];

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <SectionHeader
        section="Platform"
        title={
          targetRows.length > 0 ? (
            <>
              <CountUp value={targetRows.length} /> destination
              {targetRows.length === 1 ? '' : 's'}, <em>ready</em>.
              {/* Destinations aren't coverage: what's actually backed up is per stack
                  (Backups tab) — never claim "every byte covered" from here. */}
            </>
          ) : (
            <>
              Give your data a <em>home</em>.
            </>
          )
        }
        description="Encrypted, deduplicated restic repositories — the swarmy object store, any S3 bucket, or a node path. Each stack schedules its own backups from its Backups tab; pick an outside S3 as a schedule's second destination for an off-site copy."
      />

      <NativeTargetHero targets={targetRows} />

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <DestinationsCard targets={targetRows} />
        <ReplicatedStorePanel />
      </div>

      <div className="mt-6">
        <EstateSnapshotsCard />
      </div>

      <section id="swarmy-itself" className="mt-12">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-display text-xl font-bold">swarmy itself</h2>
            <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
              The controller's own state — orgs, nodes, settings, audit. A live replica covers losing a
              server; the passphrase-sealed nightly bundle covers losing the whole cluster.
            </p>
          </div>
          <BackupNowButton />
        </div>
        <div className="grid gap-6">
          <ReplicationCard />
          <PassphraseCard />
          <ScheduleCard />
          <SnapshotsList />
        </div>
      </section>
    </div>
  );
}
