import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ActivityIcon, BoxesIcon, CpuIcon, MemoryStickIcon, ServerIcon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, MetricCard, Progress, StatusBadge } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { EstateSummary } from '@/lib/use-estate-summary';
import { AreaTrend, useRolling } from '@/components/charts';
import { CountUp } from '@/components/count-up';

/**
 * Cluster KPIs + live CPU/memory trend — the top of the Infrastructure plane.
 * Node/service counts arrive settled from the page's estate summary (the same
 * numbers as the sidenav footer); utilisation is polled here and shimmers
 * until the first sample lands instead of showing 0%.
 */
export function ClusterHero({ estate }: { estate: EstateSummary }): React.JSX.Element {
  const trpc = useTRPC();
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

  const { nodes, services } = estate;
  const allGreen = nodes.total > 0 && nodes.online === nodes.total;
  const pct = (n: number): string => `${n.toFixed(0)}%`;

  return (
    <>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard
          label="Nodes online"
          value={
            <span className="mono-data">
              <CountUp value={nodes.online} /> / {nodes.total}
            </span>
          }
          icon={<ServerIcon className="size-4" />}
          hint={<StatusBadge tone={allGreen ? 'online' : 'warning'} label="cluster" />}
        />
        <UtilisationCard
          label="Cluster CPU"
          icon={<CpuIcon className="size-4" />}
          value={overview.data?.cpuPercent}
          format={pct}
          accent
        />
        <UtilisationCard
          label="Cluster memory"
          icon={<MemoryStickIcon className="size-4" />}
          value={overview.data?.memPercent}
          format={pct}
        />
        <MetricCard
          label="Services running"
          value={
            <span className="mono-data">
              <CountUp value={services.running} /> / {services.total}
            </span>
          }
          icon={<BoxesIcon className="size-4" />}
          hint={`${estate.containersRunning} containers · ${estate.recentDeployments} deploys (24h)`}
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
            <div className="relative h-[220px]">
              <div className="shimmer-line absolute inset-0 rounded-xl" aria-hidden />
              <p className="text-muted-foreground relative flex h-full items-center justify-center text-sm">
                Collecting live samples — the first chart lands in a few seconds.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}

/** A percentage KPI that shimmers until its first sample exists (never "0%"). */
function UtilisationCard({
  label,
  icon,
  value,
  format,
  accent,
}: {
  label: string;
  icon: React.ReactNode;
  value: number | undefined;
  format: (n: number) => string;
  accent?: boolean;
}): React.JSX.Element {
  return (
    <MetricCard
      label={label}
      value={
        value === undefined ? (
          <span className="shimmer-line inline-block h-7 w-16 rounded" aria-hidden />
        ) : (
          <CountUp className="mono-data" value={value} format={format} />
        )
      }
      icon={icon}
      accent={accent}
    >
      <Progress value={value ?? 0} className="mt-2" />
    </MetricCard>
  );
}
