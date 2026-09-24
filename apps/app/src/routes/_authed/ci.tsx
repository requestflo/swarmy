import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranchPlusIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { SectionHeader } from '@/components/section-header';
import { CountUp } from '@/components/count-up';
import { RegistryCard } from '@/components/ci/registry-card';
import { RegistryCredentialsCard } from '@/components/ci/registry-credentials-card';
import { GcPolicyCard } from '@/components/ci/gc-policy-card';
import { BuildsList } from '@/components/ci/builds-list';
// D3: registry policy (image scanning / signing / admission)
import { ScanPolicyCard } from '@/components/ci/scan-policy-card';
import { ScanList } from '@/components/ci/scan-list';
// git-apps P5: provider connections + New app from Git
import { GitConnectionsCard } from '@/components/ci/git-connections-card';
import { GitNewAppCard } from '@/components/ci/git-new-app-card';
import { GitResultBanner, parseGitResultSearch } from '@/components/ci/git-result-banner';
// git-apps P3: apps from swarmy.yaml, environments, plans
import { AppsCard } from '@/components/gitops/apps-card';

export const Route = createFileRoute('/_authed/ci')({
  validateSearch: parseGitResultSearch,
  component: CiPage,
});

function CiPage(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const repos = useQuery(trpc.cicd.listRepos.queryOptions());
  const builds = useQuery({ ...trpc.cicd.listBuilds.queryOptions({}), refetchInterval: 5000 });
  const registry = useQuery(trpc.cicd.getRegistryConfig.queryOptions());
  const gc = useQuery(trpc.cicd.getGcPolicy.queryOptions());

  const repoCount = repos.data?.length ?? 0;
  // `false` = closed; otherwise open, optionally on a just-connected provider.
  const [newApp, setNewApp] = React.useState<false | { connectionId?: string }>(false);

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <SectionHeader
        section="Deploy"
        title={
          repoCount > 0 ? (
            <>
              <CountUp value={repoCount} /> repo{repoCount === 1 ? '' : 's'} <em>wired</em>.
            </>
          ) : (
            <>
              Push to <em>deploy</em>.
            </>
          )
        }
        description="Connect a repo with a swarmy.yaml, build on your nodes, push to a registry that lives inside the swarm. No external CI."
        actions={
          <>
            <Button
              variant={newApp ? 'outline' : 'default'}
              onClick={() => setNewApp((o) => (o ? false : {}))}
            >
              <GitBranchPlusIcon className="size-4" /> New app from Git
            </Button>
          </>
        }
      />

      <GitResultBanner onStart={(connectionId) => setNewApp({ connectionId })} />
      {newApp ? (
        <GitNewAppCard
          key={newApp.connectionId ?? 'any'}
          initialConnectionId={newApp.connectionId}
          onClose={() => setNewApp(false)}
        />
      ) : null}
      <AppsCard />
      <GitConnectionsCard />

      <div className="grid gap-4 lg:grid-cols-2">
        <RegistryCard config={registry.data} />
        <RegistryCredentialsCard />
        <GcPolicyCard
          value={gc.data}
          onDone={() => qc.invalidateQueries({ queryKey: trpc.cicd.getGcPolicy.queryKey() })}
        />
        {/* D3: image admission policy + signing key */}
        <ScanPolicyCard />
      </div>

      <BuildsList builds={builds.data ?? []} />

      {/* D3: CVE scans of built images */}
      <ScanList />
    </div>
  );
}
