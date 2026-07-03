import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ServerIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { CountUp } from '@/components/count-up';
import { ClusterHero } from '@/components/infra/cluster-hero';
import { NodeList } from '@/components/nodes/node-list';
import { InfraCanvas } from '@/components/infrastructure/infra-canvas';
import {
  InfraGlobeFallback,
  InfraViewToggle,
  type InfraView,
} from '@/components/infrastructure/infra-view-toggle';

const RegionGlobe = React.lazy(
  () =>
    import('@/components/infrastructure/region-globe') as Promise<{
      default: React.ComponentType;
    }>,
);

/**
 * The Nodes plane — the cluster. ClusterHero KPIs, then the flat node list
 * (the PRIMARY navigation: control plane vs. workers, at a glance) and,
 * below it, an optional map view (Canvas or Globe) for spatial context only.
 */
export const Route = createFileRoute('/_authed/nodes/')({
  component: InfrastructurePlane,
});

function InfrastructurePlane(): React.JSX.Element {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const [view, setView] = React.useState<InfraView>('canvas');
  const nodes = useQuery({ ...trpc.nodes.list.queryOptions(), refetchInterval: 5_000 });
  const online = (nodes.data ?? []).filter((n) => n.status === 'online').length;
  const total = nodes.data?.length ?? 0;
  const allGreen = total > 0 && online === total;

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Infrastructure"
        title={
          allGreen ? (
            <>
              Your cluster's <em>healthy</em>.
            </>
          ) : (
            <>
              <CountUp value={online} /> of {total} nodes <em>online</em>.
            </>
          )
        }
        description="Every machine in your swarm — capacity, health, and what runs where."
        actions={
          <Button onClick={() => navigate({ to: '/nodes/new' })}>
            <ServerIcon className="size-4" /> Add a node
          </Button>
        }
      />

      <ClusterHero />

      <div className="mt-8">
        <NodeList />
      </div>

      <div className="mt-10 flex items-center justify-between gap-3">
        <h2 className="text-muted-foreground mono-label mb-0!">
          Map view <span className="font-normal">· optional</span>
        </h2>
        <InfraViewToggle view={view} onChange={setView} />
      </div>

      <div className="mt-4">
        {view === 'canvas' ? (
          <InfraCanvas />
        ) : (
          <React.Suspense fallback={<InfraGlobeFallback />}>
            <RegionGlobe />
          </React.Suspense>
        )}
      </div>
    </div>
  );
}
