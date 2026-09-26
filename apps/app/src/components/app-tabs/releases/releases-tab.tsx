import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { CodeView } from '@/components/calm';
import { findStackApp } from '@/components/gitops/gitops-types';
import { StackGitAppPanel } from '@/components/gitops/stack-git-app-panel';
import { CanaryPanel } from '@/components/releases/canary-panel';
import { ErrorState, HeaderSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { RowsSkeleton, TabBody } from '../tab-body';
import { ReleaseHistory } from './release-history';
import { ReleasesHeader, ReleasesNext } from './releases-header';
import { releasesCode } from './releases-code';

/**
 * Releases: what is live, a canary in flight, git environments + promote,
 * history and putting an earlier version back. Boards AppRollout · RPromote ·
 * Environments. The health watch and starting a canary are Config › Health &
 * rollout; branch previews are Config › Jobs & previews.
 */
export function ReleasesTab({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const releases = useQuery({ ...trpc.releases.list.queryOptions({ stackName: stack, limit: 50 }), refetchInterval: 5_000 });
  const apps = useQuery({ ...trpc.apps.list.queryOptions(), refetchInterval: 15_000 });
  const rows = releases.data ?? [];
  const match = apps.data ? findStackApp(apps.data, stack) : null;
  const code = releases.data ? releasesCode(stack, rows, match?.app ?? null) : null;

  if (releases.isError) {
    return <ErrorState title="Couldn't load this app's versions" error={releases.error} retry={() => void releases.refetch()} />;
  }
  return (
    <TabBody
      asideAt="controls"
      header={releases.data ? <ReleasesHeader rows={rows} /> : <HeaderSkeleton />}
      aside={
        <>
          {code ? (
            <CodeView
              title="Releases as code"
              tabs={code.tabs}
              source={code.readonly ? 'readonly' : 'dashboard'}
              note={code.readonly ? undefined : 'Deploys come from git: push, or call the same deploy the button makes.'}
            />
          ) : null}
        </>
      }
    >
      {releases.data ? <ReleasesNext rows={rows} /> : null}
      <CanaryPanel stack={stack} />
      <StackGitAppPanel stack={stack} previews={false} />
      {releases.data ? <ReleaseHistory rows={rows} /> : <RowsSkeleton />}
    </TabBody>
  );
}
