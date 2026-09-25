import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { SectionHeader } from '@/components/section-header';
import { AlreadyOn, Depth, NextAction, Say } from '@/components/calm';
import { PageError, PageSkeleton } from '@/components/states';
import { ControllerSection } from '@/components/controllerbackup/controller-section';
import { relativeTime } from './backup-format';
import { BackupsCode } from './backups-code';
import { DestinationRows } from './destination-rows';
import { DestinationsCard } from './destinations-card';
import { EstateSnapshotsCard } from './estate-snapshots-card';
import { NativeTargetHero } from './native-target-hero';
import { ReplicatedStorePanel } from './replicated-store-panel';

/**
 * /backups — one page of Sections: where backups go, the restore points
 * (restore into a new copy, or replace), and swarmy's own backup. What each
 * app backs up lives on its Backups tab.
 */
export function BackupsPage(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const targets = useQuery({ ...trpc.backups.listTargets.queryOptions(), refetchInterval: 5_000 });
  const snaps = useQuery({ ...trpc.backups.listSnapshots.queryOptions({}), refetchInterval: 5_000 });
  const storage = useQuery(trpc.storage.getConfig.queryOptions());
  const ensure = useMutation(
    trpc.backups.ensureNativeTarget.mutationOptions({
      onSuccess: () => void qc.invalidateQueries(),
      onError: (e) => toast.error(e.message),
    }),
  );
  if (targets.error && !targets.data) return <Pad><PageError error={targets.error} retry={() => void targets.refetch()} /></Pad>;
  if (!targets.data || !snaps.data) return <PageSkeleton variant="list" />;

  const t = targets.data;
  const rows = snaps.data;
  const day = rows.filter((s) => Date.now() - new Date(s.startedAt).getTime() < 26 * 3_600_000);
  const failed = day.filter((s) => s.status === 'FAILED').length;
  const last = rows.find((s) => s.status === 'SUCCEEDED');
  const broken = day.find((s) => s.status === 'FAILED');
  const title =
    t.length === 0 ? (
      <>Backups have nowhere to go yet. <Say tone="warn">Give them a home.</Say></>
    ) : failed ? (
      <>{day.length - failed} of {day.length} saves worked in the last day. <Say tone="bad">{failed} failed.</Say></>
    ) : (
      <>Every volume is saved nightly. <em>{rows.length} restore points{last ? `, the last ${relativeTime(last.startedAt)}` : ''}.</em></>
    );

  return (
    <Pad>
      <SectionHeader
        title={title}
        description="Saves are encrypted and deduplicated. Each app chooses what it saves on its Backups tab; this page is where they go, how to get them back, and swarmy's own backup."
      />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col gap-5">
          {t.length === 0 ? (
            <NextAction
              title="Keep backups on your own servers"
              tech="backups.ensureNativeTarget · a dedicated bucket + key on swarmy-garage"
              actions={
                <Button disabled={ensure.isPending || !storage.data?.enabled} onClick={() => ensure.mutate()}>
                  {ensure.isPending ? 'Setting up…' : 'Use swarmy object storage'}
                </Button>
              }
            >
              One click makes a private bucket for backups, spread across your servers. No cloud account needed.
              {!storage.data?.enabled ? ' Turn on file storage below first.' : ''}
            </NextAction>
          ) : broken ? (
            <NextAction
              tone="bad"
              title={`${broken.volume} didn’t save ${relativeTime(broken.startedAt)}`}
              tech={broken.error ?? undefined}
              actions={
                <Button asChild>
                  <Link to="/stacks/$name/backups" params={{ name: broken.volume.split('_')[0] ?? broken.volume }}>
                    Back it up again
                  </Link>
                </Button>
              }
            >
              The saves before it are still there. Run it again from its app’s Backups tab; if it fails twice, the reason is below at Controls.
            </NextAction>
          ) : null}
          <EstateSnapshotsCard />
          <DestinationRows targets={t} />
          <Depth at="controls">
            <NativeTargetHero targets={t} />
            <div className="grid gap-5 lg:grid-cols-2">
              <DestinationsCard targets={t} />
              <ReplicatedStorePanel />
            </div>
          </Depth>
          <ControllerSection />
        </div>
        <aside className="flex min-w-0 flex-col gap-4">
          <BackupsCode targets={t} />
          <AlreadyOn
            items={[
              { what: 'Nightly', detail: 'every app volume and database, with nothing to set up' },
              { what: 'Encrypted', detail: 'before it leaves the server' },
              { what: 'Restores', detail: 'into a new copy first, so nothing live changes' },
            ]}
          />
        </aside>
      </div>
    </Pad>
  );
}

function Pad({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 pb-24 lg:pb-20 xl:px-10">{children}</div>;
}
