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
  Skeleton,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { MetricSelect } from './metric-select';
import { METRIC_PRESETS } from './observability-shared';

interface MetricsPanelProps {
  enabled: boolean;
}

/** Per-minute average chart over the last hour — coral bars, no chart chrome. */
export function MetricsPanel({ enabled }: MetricsPanelProps): React.JSX.Element {
  const trpc = useTRPC();
  const [metric, setMetric] = React.useState<string>(METRIC_PRESETS[0].value);
  const series = useQuery({
    ...trpc.observability.metricsSeries.queryOptions({ metric, windowMinutes: 60, bucketSeconds: 60 }),
    enabled,
    refetchInterval: enabled ? 15_000 : false,
  });

  const points = series.data?.points ?? [];
  const max = points.reduce((m, p) => Math.max(m, p.value), 0) || 1;

  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-2">
            <GaugeIcon className="size-4" /> Metrics
          </span>
          <MetricSelect value={metric} onChange={setMetric} />
        </CardTitle>
        <CardDescription>Per-minute average over the last hour, straight from ClickHouse.</CardDescription>
      </CardHeader>
      <CardContent>
        {!enabled ? (
          <EmptyState
            icon={<GaugeIcon />}
            title="Observability is off"
            description="Turn it on to chart application and resource metrics here."
          />
        ) : series.isLoading ? (
          <Skeleton className="h-40 w-full rounded-xl" />
        ) : series.data?.status === 'unreachable' ? (
          <EmptyState icon={<GaugeIcon />} title="Store unreachable" description="ClickHouse isn't answering yet." />
        ) : points.length === 0 ? (
          <EmptyState
            icon={<GaugeIcon />}
            title="No samples yet"
            description="Metrics will populate once an enabled stack starts emitting OTLP."
          />
        ) : (
          <div className="flex h-40 items-end gap-0.5">
            {points.map((p) => (
              <div
                key={p.bucket}
                title={`${p.bucket} · ${p.value}`}
                className="bg-primary/70 hover:bg-primary min-h-[2px] flex-1 rounded-t-sm transition-colors"
                style={{ height: `${Math.max(2, (p.value / max) * 100)}%` }}
              />
            ))}
          </div>
        )}
        <div className="text-muted-foreground mt-3 flex items-center justify-between text-xs">
          <span className="mono-data">{metric}</span>
          {points.length > 0 ? <span className="mono-data">peak {max}</span> : null}
        </div>
      </CardContent>
    </Card>
  );
}
