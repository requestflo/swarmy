import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ServerIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { useEstateSummary } from '@/lib/use-estate-summary';
import { PageHeader } from '@/components/page-header';
import { CountUp } from '@/components/count-up';
import { ClusterHero } from '@/components/infra/cluster-hero';
import { NodeList } from '@/components/nodes/node-list';
import { SwarmHealthCard } from '@/components/nodes/swarm-health-card';
import { RecoveryClaimsBanner } from '@/components/nodes/recovery-claims-banner';
import { InfraCanvas } from '@/components/infrastructure/infra-canvas';
import {
  InfraGlobeFallback,
  InfraViewToggle,
  type InfraView,
} from '@/components/infrastructure/infra-view-toggle';
import { PageError, PageSkeleton } from '@/components/states';

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
 * The headline counts come from the same estate summary as the Overview and
 * the sidenav footer, and nothing paints until it has settled.
 */
export const Route = createFileRoute('/_authed/nodes/')({
  component: InfrastructurePlane,
});

function InfrastructurePlane(): React.JSX.Element {
  const navigate = useNavigate();
  const [view, setView] = React.useState<InfraView>('canvas');
  const estate = useEstateSummary();

  if (estate.status === 'pending') return <PageSkeleton variant="kpis" />;
  if (estate.status === 'error') {
    return (
      <PageError
        title="Couldn’t reach your cluster."
        error={estate.error}
        retry={estate.refetch}
        retrying={estate.isFetching}
      />
    );
  }

  const { online, total } = estate.data.nodes;
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

      <ClusterHero estate={estate.data} />

      <div className="mt-4">
        <RecoveryClaimsBanner />
      </div>

      <div className="mt-8">
        <NodeList />
      </div>

      {/* Manager quorum + recovery tooling (admin-only; hides itself otherwise). */}
      <SwarmHealthCard />

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
