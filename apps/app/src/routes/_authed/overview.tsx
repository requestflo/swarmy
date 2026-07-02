import * as React from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  ActivityIcon,
  ArrowRightIcon,
  BellIcon,
  DatabaseBackupIcon,
  LifeBuoyIcon,
  RocketIcon,
  ServerIcon,
  SirenIcon,
} from 'lucide-react';
import { cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CountUp } from '@/components/count-up';

/**
 * The Overview — the first thing you see. A calm estate summary: is everything
 * green, what's on fire, what shipped, and what to do next. Every card is a
 * doorway into the relevant section, so this is the map of the whole product.
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
          Your whole platform, one screen. Everything else is a click away in the sidebar.
        </p>
      </div>

      {emptyEstate ? (
        <OnboardingChecklist hasNodes={false} />
      ) : (
        <>
          {/* KPI row */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Kpi
              to="/nodes"
              icon={<ServerIcon className="size-4" />}
              label="Nodes online"
              value={nodes?.online ?? 0}
              suffix={nodes ? `/${nodes.total}` : ''}
              tone={allNodesUp ? 'online' : (nodes?.online ?? 0) > 0 ? 'warning' : 'idle'}
            />
            <Kpi
              to="/"
              icon={<ActivityIcon className="size-4" />}
              label="Services running"
              value={services?.running ?? 0}
              suffix={services ? `/${services.total}` : ''}
              tone={services && services.running === services.total ? 'online' : 'progress'}
            />
            <Kpi
              to="/alerts"
              icon={<BellIcon className="size-4" />}
              label="Alerts firing"
              value={firing}
              tone={firing > 0 ? 'warning' : 'online'}
            />
            <Kpi
              to="/incidents"
              icon={<SirenIcon className="size-4" />}
              label="Open incidents"
              value={openIncidents}
              tone={openIncidents > 0 ? 'offline' : 'online'}
            />
          </div>

          {/* Attention + activity */}
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

function Kpi({
  to,
  icon,
  label,
  value,
  suffix,
  tone,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  value: number;
  suffix?: string;
  tone: 'online' | 'warning' | 'offline' | 'progress' | 'idle';
}): React.JSX.Element {
  return (
    <Link to={to} className="card-pop card-pop-hover block p-5">
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <span style={{ color: `var(--status-${tone})` }}>{icon}</span>
        <span className="truncate">{label}</span>
      </div>
      <div className="mono-data mt-3 text-3xl font-bold">
        <CountUp value={value} />
        {suffix ? <span className="text-muted-foreground text-xl">{suffix}</span> : null}
      </div>
    </Link>
  );
}

function AttentionCard({ firing, openIncidents }: { firing: number; openIncidents: number }): React.JSX.Element {
  const calm = firing === 0 && openIncidents === 0;
  return (
    <div className="card-pop p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-display text-lg font-bold">Needs attention</h2>
        <BellIcon className="text-muted-foreground size-4" />
      </div>
      {calm ? (
        <p className="text-muted-foreground text-sm">Nothing on fire. Quiet and green.</p>
      ) : (
        <div className="space-y-2">
          {firing > 0 && (
            <RowLink to="/alerts" tone="warning">
              {firing} alert{firing === 1 ? '' : 's'} firing
            </RowLink>
          )}
          {openIncidents > 0 && (
            <RowLink to="/incidents" tone="offline">
              {openIncidents} open incident{openIncidents === 1 ? '' : 's'}
            </RowLink>
          )}
        </div>
      )}
    </div>
  );
}

function ReleasesCard({
  deploying,
  healthy,
  failed,
  lastDeployAt,
}: {
  deploying: number;
  healthy: number;
  failed: number;
  lastDeployAt: string | null;
}): React.JSX.Element {
  return (
    <div className="card-pop p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-display text-lg font-bold">Deployments</h2>
        <RocketIcon className="text-muted-foreground size-4" />
      </div>
      <div className="flex items-center gap-4 text-sm">
        <Stat n={deploying} label="in flight" tone="progress" />
        <Stat n={healthy} label="healthy" tone="online" />
        <Stat n={failed} label="failed" tone="offline" />
      </div>
      <p className="text-muted-foreground mt-3 text-xs">
        {lastDeployAt ? `Last deploy ${relativeTime(lastDeployAt)}` : 'No deploys yet.'}
      </p>
      <Link to="/releases" className="text-primary mt-2 inline-flex items-center gap-1 text-sm font-semibold">
        Release history <ArrowRightIcon className="size-3.5" />
      </Link>
    </div>
  );
}

function ResilienceCard({ score, headline }: { score: number | null; headline: string | null }): React.JSX.Element {
  const tone = score == null ? 'idle' : score >= 80 ? 'online' : score >= 50 ? 'warning' : 'offline';
  return (
    <div className="card-pop p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-display text-lg font-bold">Resilience</h2>
        <LifeBuoyIcon className="text-muted-foreground size-4" />
      </div>
      {score == null ? (
        <p className="text-muted-foreground text-sm">Run a readiness check to get your score.</p>
      ) : (
        <>
          <div className="mono-data text-3xl font-bold" style={{ color: `var(--status-${tone})` }}>
            {score}%
          </div>
          <p className="text-muted-foreground mt-1 text-xs">{headline}</p>
        </>
      )}
      <Link to="/resilience" className="text-primary mt-2 inline-flex items-center gap-1 text-sm font-semibold">
        Resilience & drills <ArrowRightIcon className="size-3.5" />
      </Link>
    </div>
  );
}

function OnboardingChecklist({ hasNodes }: { hasNodes: boolean }): React.JSX.Element {
  const steps = [
    { done: hasNodes, label: 'Add your first node', to: '/nodes/new', icon: <ServerIcon className="size-4" /> },
    { done: false, label: 'Deploy a service or a blueprint', to: '/blueprints', icon: <RocketIcon className="size-4" /> },
    { done: false, label: 'Point a domain at it', to: '/ingress', icon: <ActivityIcon className="size-4" /> },
    { done: false, label: 'Set up backups', to: '/backups', icon: <DatabaseBackupIcon className="size-4" /> },
    { done: false, label: 'Turn on alerts', to: '/alerts', icon: <BellIcon className="size-4" /> },
  ];
  return (
    <div className="ink-block mt-4 rounded-2xl p-6">
      <h2 className="font-display text-ink-foreground text-lg font-bold">Get set up</h2>
      <p className="text-ink-foreground/60 mt-1 text-sm">Five steps to a production-grade platform.</p>
      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {steps.map((s) => (
          <Link
            key={s.label}
            to={s.to}
            className={cn(
              'flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors',
              s.done ? 'bg-white/5' : 'bg-white/5 hover:bg-white/10',
            )}
          >
            <span
              className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-full text-xs',
                s.done ? 'bg-status-online/20 text-status-online' : 'bg-white/10 text-ink-foreground/70',
              )}
            >
              {s.done ? '✓' : s.icon}
            </span>
            <span className={cn('text-sm', s.done ? 'text-ink-foreground/50 line-through' : 'text-ink-foreground')}>
              {s.label}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

function Stat({ n, label, tone }: { n: number; label: string; tone: string }): React.JSX.Element {
  return (
    <div>
      <div className="mono-data text-2xl font-bold" style={{ color: `var(--status-${tone})` }}>
        {n}
      </div>
      <div className="text-muted-foreground text-xs">{label}</div>
    </div>
  );
}

function RowLink({
  to,
  tone,
  children,
}: {
  to: string;
  tone: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Link
      to={to}
      className="hover:bg-accent flex items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors"
    >
      <span className="flex items-center gap-2">
        <span className="size-2 rounded-full" style={{ background: `var(--status-${tone})` }} />
        {children}
      </span>
      <ArrowRightIcon className="text-muted-foreground size-3.5" />
    </Link>
  );
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
