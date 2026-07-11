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
import { ControllerBackupCallout } from '@/components/backups/controller-backup-callout';

/**
 * Global Backups = destinations. Where backups go lives here; what gets
 * backed up (schedules, snapshots, drills) lives in each stack's Backups tab.
 */
export const Route = createFileRoute('/_authed/backups')({
  component: BackupDestinationsPage,
});

function BackupDestinationsPage(): React.JSX.Element {
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
              {targetRows.length === 1 ? '' : 's'}, every byte <em>covered</em>.
            </>
          ) : (
            <>
              Give your data a <em>home</em>.
            </>
          )
        }
        description="Encrypted, deduplicated restic repositories — the swarmy object store, any S3 bucket, or a node path. Each stack schedules its own backups from its Backups tab."
      />

      <NativeTargetHero targets={targetRows} />

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <DestinationsCard targets={targetRows} />
        <div className="space-y-6">
          <ReplicatedStorePanel />
          <ControllerBackupCallout />
        </div>
      </div>

      <div className="mt-6">
        <EstateSnapshotsCard />
      </div>
    </div>
  );
}
