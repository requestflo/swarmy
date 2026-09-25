import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranchPlusIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CodeView, Depth, Say } from '@/components/calm';
import { RowPage, plural } from '@/components/rowpage/row-page';
import { AppsCard } from '@/components/gitops/apps-card';
import { relTime } from '@/lib/format';
import { BuildsList, repoName } from './builds-list';
import { ciCode } from './ci-code';
import { GcPolicyCard } from './gc-policy-card';
import { GitConnectionsCard } from './git-connections-card';
import { GitNewAppCard } from './git-new-app-card';
import { GitResultBanner } from './git-result-banner';
import { RegistryCard } from './registry-card';
import { RegistryCredentialsCard } from './registry-credentials-card';
import { RegistrySummary } from './registry-summary';
import { ScanList } from './scan-list';
import { ScanPolicyCard } from './scan-policy-card';

/** Settings → CI & registry: git → build on your servers → the registry inside them. */
export function CiPage(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const repos = useQuery(trpc.cicd.listRepos.queryOptions());
  const builds = useQuery({ ...trpc.cicd.listBuilds.queryOptions({}), refetchInterval: 5000 });
  const registry = useQuery(trpc.cicd.getRegistryConfig.queryOptions());
  const creds = useQuery(trpc.registryCredentials.list.queryOptions());
  const gc = useQuery(trpc.cicd.getGcPolicy.queryOptions());
  const [newApp, setNewApp] = React.useState<false | { connectionId?: string }>(false);
  const last = builds.data?.[0];

  const title = !repos.data || !builds.data ? (
    'Git, builds and the registry.'
  ) : repos.data.length === 0 ? (
    <>Nothing builds from git yet. <em>Connect a repo and push to deploy.</em></>
  ) : (
    <>
      {plural(repos.data.length, 'repo')} build here.{' '}
      {last ? (
        last.status === 'failed' ? <Say tone="bad">The last build failed {relTime(last.startedAt)}.</Say> : <em>Last build {relTime(last.startedAt)}.</em>
      ) : <em>No builds yet.</em>}
    </>
  );

  return (
    <RowPage
      title={title}
      description="Builds run on your own servers and push to a registry that lives inside them. No outside CI needed."
      actions={
        <Button variant={newApp ? 'outline' : 'default'} className="pointer-coarse:min-h-11" onClick={() => setNewApp((o) => (o ? false : {}))}>
          <GitBranchPlusIcon className="size-4" /> New app from Git
        </Button>
      }
      aside={
        <>
          <CodeView title="CI as code" tabs={ciCode(registry.data ?? null)} note="Repos and registry logins are on the public API; builds read the repo's swarmy.yaml." />
          <RegistrySummary config={registry.data} credentials={creds.data?.length} />
        </>
      }
    >
      <GitResultBanner onStart={(connectionId) => setNewApp({ connectionId })} />
      {newApp ? <GitNewAppCard key={newApp.connectionId ?? 'any'} initialConnectionId={newApp.connectionId} onClose={() => setNewApp(false)} /> : null}
      <AppsCard />
      <BuildsList builds={builds.data ?? []} />
      <Depth at="controls">
        <GitConnectionsCard />
        <div className="grid gap-4 2xl:grid-cols-2">
          <RegistryCard config={registry.data} />
          <RegistryCredentialsCard />
          <GcPolicyCard value={gc.data} onDone={() => qc.invalidateQueries({ queryKey: trpc.cicd.getGcPolicy.queryKey() })} />
          <ScanPolicyCard />
        </div>
        <ScanList />
      </Depth>
    </RowPage>
  );
}
