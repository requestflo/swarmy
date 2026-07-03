import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { GaugeIcon } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Progress,
  Skeleton,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { MetricSelect } from './metric-select';
import { METRIC_PRESETS } from './observability-shared';

interface ServiceMetricsPanelProps {
  enabled: boolean;
  /** Scope the breakdown to one stack (`swarmy.stack` resource attribute). */
  stack?: string;
}

/** Per-service average + peak — flat rows in one card-pop with proportion bars. */
export function ServiceMetricsPanel({ enabled, stack }: ServiceMetricsPanelProps): React.JSX.Element {
  const trpc = useTRPC();
  const [metric, setMetric] = React.useState<string>(METRIC_PRESETS[0].value);
  const summary = useQuery({
    ...trpc.observability.metricsSummary.queryOptions({ metric, windowMinutes: 60, limit: 20, stack }),
    enabled,
    refetchInterval: enabled ? 15_000 : false,
  });

  const rows = summary.data?.rows ?? [];
  const peak = rows.reduce((m, r) => Math.max(m, r.avg_value), 0) || 1;

  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-2">
            <GaugeIcon className="size-4" /> By service
          </span>
          <MetricSelect value={metric} onChange={setMetric} />
        </CardTitle>
        <CardDescription>Per-service average and peak over the last hour.</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {!enabled ? (
          <EmptyState
            className="mx-6 mb-6"
            icon={<GaugeIcon />}
            title="Observability is off"
            description="Turn it on to break metrics down per service."
          />
        ) : summary.isLoading ? (
          <div className="space-y-2 px-6 pb-6">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full rounded-xl" />
            ))}
          </div>
        ) : summary.data?.status === 'unreachable' ? (
          <EmptyState
            className="mx-6 mb-6"
            icon={<GaugeIcon />}
            title="Store unreachable"
            description="ClickHouse isn't answering yet."
          />
        ) : rows.length === 0 ? (
          <EmptyState
            className="mx-6 mb-6"
            icon={<GaugeIcon />}
            title="No samples yet"
            description="Enabled stacks emitting this metric will list here."
          />
        ) : (
          <div className="border-t">
            {rows.map((r) => (
              <div
                key={r.service_name}
                className="hover:bg-accent/60 grid grid-cols-[1fr_auto] items-center gap-x-4 border-b px-6 py-3 transition-colors last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="mono-data truncate text-sm font-medium">{r.service_name}</p>
                  <Progress
                    className="mt-1.5 h-1.5"
                    value={Math.max(2, (r.avg_value / peak) * 100)}
                  />
                </div>
                <div className="text-right">
                  <p className="mono-data text-sm font-medium">{r.avg_value}</p>
                  <p className="text-muted-foreground mono-label">peak {r.max_value}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
