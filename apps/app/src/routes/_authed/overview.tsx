import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ActivityIcon, BellIcon, ServerIcon, SirenIcon } from 'lucide-react';
import { useTRPC } from '@/integrations/trpc';
import { AttentionCard } from '@/components/overview/attention-card';
import { KpiCard } from '@/components/overview/kpi-card';
import { OnboardingChecklist } from '@/components/overview/onboarding-checklist';
import { ReleasesCard } from '@/components/overview/releases-card';
import { ResilienceCard } from '@/components/overview/resilience-card';
import { StacksHealthStrip } from '@/components/overview/stacks-health-strip';

/**
 * The Overview — the first thing you see. A calm estate rollup: is everything
 * green, what's on fire, and which stack needs you. Every card is a doorway
 * into a stack workspace or ops page, so this is the map of the whole estate.
 */
export const Route = createFileRoute('/_authed/overview')({
  component: OverviewPage,
});

function OverviewPage(): React.JSX.Element {
  const trpc = useTRPC();
  const summary = useQuery({ ...trpc.system.dashboardSummary.queryOptions(), refetchInterval: 5_000 });
  const alerts = useQuery({ ...trpc.alerts.overview.queryOptions(), refetchInterval: 15_000 });
  const incidents = useQuery({ ...trpc.incidents.overview.queryOptions(), refetchInterval: 15_000 });
  const releases = useQuery({ ...trpc.releases.overview.queryOptions(), refetchInterval: 15_000 });
  const resilience = useQuery(trpc.resilience.overview.queryOptions());

  const nodes = summary.data?.nodes;
  const services = summary.data?.services;
  const firing = alerts.data?.firing ?? 0;
  const openIncidents = incidents.data?.open ?? 0;
  const allNodesUp = !!nodes && nodes.total > 0 && nodes.online === nodes.total;

  const emptyEstate = !!nodes && nodes.total === 0;
  const headline = emptyEstate
    ? 'Let’s get you live.'
    : firing > 0 || openIncidents > 0
      ? 'Something needs you.'
      : allNodesUp
        ? 'All green.'
        : 'A few things to check.';
  const headlineEm = emptyEstate ? 'live' : firing > 0 || openIncidents > 0 ? 'you' : allNodesUp ? 'green' : 'check';

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <div className="mb-8">
        <span className="eyebrow">Overview</span>
        <h1 className="headline mt-3 text-[2.2rem] sm:text-5xl">
          {headline.replace(headlineEm, '')}
          <em>{headlineEm}</em>
          {headline.endsWith('.') ? '' : '.'}
        </h1>
        <p className="text-muted-foreground mt-2 text-sm sm:text-base">
          Your whole estate, one screen. Every card below opens the workspace that owns it.
        </p>
      </div>

      {emptyEstate ? (
        <OnboardingChecklist hasNodes={false} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <KpiCard
              to="/nodes"
              icon={<ServerIcon className="size-4" />}
              label="Nodes online"
              value={nodes?.online ?? 0}
              suffix={nodes ? `/${nodes.total}` : ''}
              tone={allNodesUp ? 'online' : (nodes?.online ?? 0) > 0 ? 'warning' : 'idle'}
            />
            <KpiCard
              to="/"
              icon={<ActivityIcon className="size-4" />}
              label="Services running"
              value={services?.running ?? 0}
              suffix={services ? `/${services.total}` : ''}
              tone={services && services.running === services.total ? 'online' : 'progress'}
            />
            <KpiCard
              to="/alerts"
              icon={<BellIcon className="size-4" />}
              label="Alerts firing"
              value={firing}
              tone={firing > 0 ? 'warning' : 'online'}
            />
            <KpiCard
              to="/incidents"
              icon={<SirenIcon className="size-4" />}
              label="Open incidents"
              value={openIncidents}
              tone={openIncidents > 0 ? 'offline' : 'online'}
            />
          </div>

          <StacksHealthStrip />

          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
            <AttentionCard firing={firing} openIncidents={openIncidents} />
            <ReleasesCard
              deploying={releases.data?.deploying ?? 0}
              healthy={releases.data?.healthy ?? 0}
              failed={releases.data?.failed ?? 0}
              lastDeployAt={releases.data?.lastDeployAt ?? null}
            />
            <ResilienceCard
              score={resilience.data?.ready ? resilience.data.score.score : null}
              headline={resilience.data?.ready ? resilience.data.score.headline : null}
            />
          </div>

          <OnboardingChecklist hasNodes />
        </>
      )}
    </div>
  );
}
