import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCwIcon } from 'lucide-react';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CodeView, Depth, NextAction, Say } from '@/components/calm';
import { ErrorState, SkeletonBody } from '@/components/states';
import { RowPage } from '@/components/rowpage/row-page';
import { ImportReleaseButton } from './import-release-button';
import { PolicyCard } from './policy-card';
import { ReleaseFacts } from './release-facts';
import { ReleaseNotes } from './release-notes';
import { ReleaseSteps } from './release-steps';
import { RunHistory } from './run-history';
import { RunStatus } from './run-status';
import { UpgradeDialog } from './upgrade-dialog';
import { useIsPlatformAdmin, usePlatformStatus } from './use-platform';

/** Settings → Platform & upgrades: the version you run, the next one, and one button that upgrades everything in order. */
export function PlatformPage(): React.JSX.Element {
  const admin = useIsPlatformAdmin();
  const q = usePlatformStatus();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const check = useMutation(trpc.platform.check.mutationOptions({ onSuccess: () => { toast.success('Checked for updates'); void qc.invalidateQueries(); }, onError: (e) => toast.error(e.message) }));
  const v = q.data;
  const av = v?.release.available;
  const run = v?.run;
  const title = !v ? 'swarmy itself.' : run?.status === 'running' ? (
    <>Upgrading to {run.toVersion}. <em>Apps keep serving.</em></>
  ) : run?.status === 'failed' ? (
    <>You’re on {v.release.current.version}. <Say tone="bad">The upgrade to {run.toVersion} stopped.</Say></>
  ) : av ? (
    <>You’re on {v.release.current.version}. <Say tone="info">{av.version} is ready.</Say></>
  ) : (
    <>You’re on {v.release.current.version}. <em>Up to date.</em></>
  );
  const lede = v
    ? `${v.release.policy.channel === 'edge' ? 'Edge channel: every main build.' : 'Stable channel: tagged releases.'} Nothing changes until someone presses the button; swarmy backs up first and goes one piece at a time.`
    : undefined;

  return (
    <RowPage
      title={title}
      description={lede}
      aside={
        v ? (
          <>
            <CodeView title="The release, as swarmy sees it" tabs={[{ label: 'release', code: JSON.stringify(v.release, null, 2) }, { label: 'run', code: JSON.stringify(v.run, null, 2) }]} source="readonly" />
            <ReleaseFacts v={v} />
          </>
        ) : undefined
      }
    >
      {q.isLoading ? (
        <SkeletonBody variant="list" />
      ) : q.isError ? (
        <ErrorState title="Couldn’t read the platform status." error={q.error} retry={() => void q.refetch()} />
      ) : v ? (
        <>
          {run && (run.status === 'running' || run.status === 'failed') ? <RunStatus run={run} admin={admin} /> : av && admin ? (
            <NextAction
              tone="info"
              title={`${av.version} is ready to install.`}
              tech={`${v.release.current.version} → ${av.version} · ${av.verified ? 'signed, verified' : 'unverified'}`}
              actions={<UpgradeDialog av={av} />}
              hint={av.blocked ?? (av.migrations.some((m) => m.pause) ? 'Includes a brief pause for object storage.' : 'Rolling: apps keep serving.')}
            >
              Backed up first, one piece at a time, each put back on its own if it doesn’t come up healthy.
            </NextAction>
          ) : null}
          {av?.notes.length ? <ReleaseNotes av={av} /> : null}
          <Depth at="controls">
            {admin ? (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" className="pointer-coarse:min-h-11" onClick={() => check.mutate()} disabled={check.isPending}>
                  <RefreshCwIcon className="size-3.5" /> Check for updates
                </Button>
                <ImportReleaseButton />
              </div>
            ) : null}
            <ReleaseSteps v={v} />
            <div className="grid gap-5 2xl:grid-cols-2">
              <PolicyCard admin={admin} />
              <RunHistory />
            </div>
          </Depth>
        </>
      ) : null}
    </RowPage>
  );
}
