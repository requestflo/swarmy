import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ActivityIcon, BoxesIcon, CpuIcon, MemoryStickIcon, ServerIcon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, MetricCard, Progress, StatusBadge } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { AreaTrend, useRolling } from '@/components/charts';
import { CountUp } from '@/components/count-up';

/** Cluster KPIs + live CPU/memory trend — the top of the Infrastructure plane. */
export function ClusterHero(): React.JSX.Element {
  const trpc = useTRPC();
  const summary = useQuery({ ...trpc.system.dashboardSummary.queryOptions(), refetchInterval: 5_000 });
  const overview = useQuery({ ...trpc.metrics.overview.queryOptions(), refetchInterval: 2_000 });

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
    <>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard
          label="Nodes online"
          value={<span className="mono-data"><CountUp value={s?.nodes.online ?? 0} /> / {s?.nodes.total ?? 0}</span>}
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
          value={<span className="mono-data"><CountUp value={s?.services.running ?? 0} /> / {s?.services.total ?? 0}</span>}
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
    </>
  );
}
