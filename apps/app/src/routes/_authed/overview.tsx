import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { useEstateSummary } from '@/lib/use-estate-summary';
import { AttentionCard } from '@/components/overview/attention-card';
import { EstateKpis } from '@/components/overview/estate-kpis';
import { OnboardingChecklist } from '@/components/overview/onboarding-checklist';
import { OverviewHeadline } from '@/components/overview/overview-headline';
import { ReleasesCard } from '@/components/overview/releases-card';
import { ResilienceCard } from '@/components/overview/resilience-card';
import { StacksHealthStrip } from '@/components/overview/stacks-health-strip';
import { PageError, PageSkeleton } from '@/components/states';

/**
 * The Overview — the first thing you see. A calm estate rollup: is everything
 * green, what's on fire, and which stack needs you. Every number on the page
 * comes from `useEstateSummary` (one source, one cadence), and nothing paints
 * until that summary has settled — unknown is a skeleton, never a zero.
 */
export const Route = createFileRoute('/_authed/overview')({
  component: OverviewPage,
});

function OverviewPage(): React.JSX.Element {
  const trpc = useTRPC();
  const estate = useEstateSummary();
  const releases = useQuery({ ...trpc.releases.overview.queryOptions(), refetchInterval: 15_000 });
  const resilience = useQuery(trpc.resilience.overview.queryOptions());

  if (estate.status === 'pending') return <PageSkeleton variant="kpis" />;
  if (estate.status === 'error') {
    return (
      <PageError
        title="Couldn’t reach your estate."
        error={estate.error}
        retry={estate.refetch}
        retrying={estate.isFetching}
      />
    );
  }

  const { nodes, services, alerts, incidents } = estate.data;
  const emptyEstate = nodes.total === 0;

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <OverviewHeadline estate={estate.data} />

      {emptyEstate ? (
        <OnboardingChecklist hasNodes={false} />
      ) : (
        <>
          <EstateKpis estate={estate.data} />

          <StacksHealthStrip />

          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
            <AttentionCard firing={alerts.firing} openIncidents={incidents.open} />
            <ReleasesCard
              deploying={releases.data?.deploying ?? 0}
              healthy={releases.data?.healthy ?? 0}
              failed={releases.data?.failed ?? 0}
              lastDeployAt={releases.data?.lastDeployAt ?? null}
              loading={releases.isPending}
            />
            <ResilienceCard
              score={resilience.data?.ready ? resilience.data.score.score : null}
              headline={resilience.data?.ready ? resilience.data.score.headline : null}
            />
          </div>

          <OnboardingChecklist
            hasNodes
            hasServices={services.total > 0}
            hasAlertChannel={alerts.channels > 0}
          />
        </>
      )}
    </div>
  );
}
