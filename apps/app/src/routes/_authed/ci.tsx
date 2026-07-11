import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { SectionHeader } from '@/components/section-header';
import { CountUp } from '@/components/count-up';
import { RegistryCard } from '@/components/ci/registry-card';
import { GcPolicyCard } from '@/components/ci/gc-policy-card';
import { ReposList } from '@/components/ci/repos-list';
import { BuildsList } from '@/components/ci/builds-list';
// D3: registry policy (image scanning / signing / admission)
import { ScanPolicyCard } from '@/components/ci/scan-policy-card';
import { ScanList } from '@/components/ci/scan-list';
// D4: PR preview environments
import { PreviewsSection } from '@/components/ci/previews-section';

export const Route = createFileRoute('/_authed/ci')({
  component: CiPage,
});

function CiPage(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const repos = useQuery(trpc.cicd.listRepos.queryOptions());
  const builds = useQuery({ ...trpc.cicd.listBuilds.queryOptions({}), refetchInterval: 5000 });
  const registry = useQuery(trpc.cicd.getRegistryConfig.queryOptions());
  const gc = useQuery(trpc.cicd.getGcPolicy.queryOptions());

  const invalidate = React.useCallback(() => qc.invalidateQueries(), [qc]);
  const repoCount = repos.data?.length ?? 0;
  const [createOpen, setCreateOpen] = React.useState(false);

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
        description="Link a repo, build on your nodes, push to a registry that lives inside the swarm. No external CI."
        actions={
          <Button onClick={() => setCreateOpen((o) => !o)}>
            <PlusIcon className="size-4" /> Link a repo
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <RegistryCard config={registry.data} />
        <GcPolicyCard
          value={gc.data}
          onDone={() => qc.invalidateQueries({ queryKey: trpc.cicd.getGcPolicy.queryKey() })}
        />
        {/* D3: image admission policy + signing key */}
        <ScanPolicyCard />
      </div>

      <ReposList
        repos={repos.data ?? []}
        onChanged={invalidate}
        createOpen={createOpen}
        onCreateOpenChange={setCreateOpen}
      />

      <BuildsList builds={builds.data ?? []} />

      {/* D3: CVE scans of built images */}
      <ScanList />

      {/* D4: PR preview environments */}
      <PreviewsSection repos={repos.data ?? []} />
    </div>
  );
}
