import * as React from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ActivityIcon, BoxesIcon, CpuIcon, MemoryStickIcon, ServerIcon } from 'lucide-react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  MetricCard,
  Progress,
  StatusBadge,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { AreaTrend, useRolling } from '@/components/charts';
import { CountUp } from '@/components/count-up';
import { pct } from '@/lib/format';

export const Route = createFileRoute('/_authed/')({
  component: OverviewPage,
});

function OverviewPage(): React.JSX.Element {
  const trpc = useTRPC();
  const summary = useQuery({ ...trpc.system.dashboardSummary.queryOptions(), refetchInterval: 5_000 });
  const overview = useQuery({ ...trpc.metrics.overview.queryOptions(), refetchInterval: 2_000 });
  const nodes = useQuery({ ...trpc.nodes.list.queryOptions(), refetchInterval: 5_000 });

  const point = React.useMemo(
    () =>
      overview.data
        ? {
            t: new Date().toLocaleTimeString(),
            cpu: Number(overview.data.cpuPercent.toFixed(1)),
            mem: Number(overview.data.memPercent.toFixed(1)),
          }
        : undefined,
    [overview.dataUpdatedAt, overview.data],
  );
  const trend = useRolling(point, 60);

  const s = summary.data;
  const allGreen = (s?.nodes.online ?? 0) === (s?.nodes.total ?? 0) && (s?.nodes.total ?? 0) > 0;

  return (
    <div className="mesh mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Overview"
        title={allGreen ? <>Everything's <em>green</em>.</> : <>Your swarm, <em>at a glance</em>.</>}
        description="Live health across every node, service, and deploy."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard
          label="Nodes online"
          value={
            <span className="mono-data">
              <CountUp value={s?.nodes.online ?? 0} /> / {s?.nodes.total ?? 0}
            </span>
          }
          icon={<ServerIcon className="size-4" />}
          hint={<StatusBadge tone={allGreen ? 'online' : 'warning'} label="cluster" />}
        />
        <MetricCard
          label="Cluster CPU"
          value={<CountUp className="mono-data" value={overview.data?.cpuPercent ?? 0} format={(n) => `${n.toFixed(0)}%`} />}
          icon={<CpuIcon className="size-4" />}
          accent
        >
          <Progress value={overview.data?.cpuPercent ?? 0} className="mt-2" />
        </MetricCard>
        <MetricCard
          label="Cluster memory"
          value={<CountUp className="mono-data" value={overview.data?.memPercent ?? 0} format={(n) => `${n.toFixed(0)}%`} />}
          icon={<MemoryStickIcon className="size-4" />}
        >
          <Progress value={overview.data?.memPercent ?? 0} className="mt-2" />
        </MetricCard>
        <MetricCard
          label="Services running"
          value={
            <span className="mono-data">
              <CountUp value={s?.services.running ?? 0} /> / {s?.services.total ?? 0}
            </span>
          }
          icon={<BoxesIcon className="size-4" />}
          hint={`${s?.containersRunning ?? 0} containers · ${s?.recentDeployments ?? 0} deploys (24h)`}
        />
      </div>

      <Card className="card-pop mt-6 border-0">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ActivityIcon className="text-primary size-4" /> Cluster utilization
          </CardTitle>
        </CardHeader>
        <CardContent>
          {trend.length > 1 ? (
            <AreaTrend
              data={trend}
              yMax={100}
              unit="%"
              series={[
                { key: 'cpu', color: 'var(--color-chart-1)', label: 'CPU' },
                { key: 'mem', color: 'var(--color-chart-3)', label: 'Memory' },
              ]}
            />
          ) : (
            <div className="text-muted-foreground flex h-[220px] items-center justify-center text-sm">
              Collecting live samples…
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="card-pop mt-6 border-0">
        <CardHeader>
          <CardTitle className="text-base">Nodes</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2">
          {(nodes.data ?? []).map((n) => (
            <Link
              key={n.id}
              to="/nodes/$nodeId"
              params={{ nodeId: n.id }}
              className="hover:bg-accent/60 -mx-2 flex items-center justify-between rounded-xl px-4 py-3 transition-colors"
            >
              <div className="flex items-center gap-3">
                <StatusBadge
                  tone={n.status === 'online' ? 'online' : n.status === 'draining' ? 'warning' : 'offline'}
                  label=""
                />
                <div>
                  <p className="font-medium">{n.name}</p>
                  <p className="text-muted-foreground mono-label">
                    {n.role} · {n.os ?? 'unknown'} · {n.arch ?? ''}
                  </p>
                </div>
              </div>
              <div className="hidden w-48 items-center gap-4 text-xs sm:flex">
                <div className="flex-1">
                  <span className="mono-label">CPU {pct(n.live?.cpuPercent)}</span>
                  <Progress value={n.live?.cpuPercent ?? 0} className="mt-1" />
                </div>
                <div className="flex-1">
                  <span className="mono-label">MEM {pct(n.live?.memPercent)}</span>
                  <Progress value={n.live?.memPercent ?? 0} className="mt-1" />
                </div>
              </div>
            </Link>
          ))}
          {nodes.data?.length === 0 && (
            <p className="text-muted-foreground py-10 text-center text-sm">
              Quiet so far. Add a node from{' '}
              <Link to="/settings" className="text-primary underline">
                Settings → Join tokens
              </Link>
              .
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
