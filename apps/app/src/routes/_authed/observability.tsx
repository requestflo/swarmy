import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ActivityIcon, GaugeIcon, ListTreeIcon } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Label,
  Skeleton,
  StatusBadge,
  Switch,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { CountUp } from '@/components/count-up';

export const Route = createFileRoute('/_authed/observability')({
  component: ObservabilityPage,
});

const METRIC_PRESETS = [
  { value: 'http.server.duration', label: 'Request latency' },
  { value: 'system.cpu.utilization', label: 'CPU utilization' },
  { value: 'system.memory.usage', label: 'Memory usage' },
] as const;

function ObservabilityPage(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const status = useQuery({ ...trpc.observability.status.queryOptions(), refetchInterval: 5_000 });
  const enabled = !!status.data?.enabled;

  const setEnabled = useMutation(
    trpc.observability.setEnabled.mutationOptions({
      onSuccess: () => {
        toast.success('Observability updated');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const collectorStatus = status.data?.collectorStatus ?? 'OFFLINE';
  const storeReachable = !!status.data?.storeReachable;
  const stacksEnabled = status.data?.stacksEnabled ?? 0;

  const heroTone =
    collectorStatus === 'RUNNING' && storeReachable
      ? 'online'
      : collectorStatus === 'DEPLOYING'
        ? 'progress'
        : collectorStatus === 'FAILED'
          ? 'offline'
          : 'neutral';

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Mission Control"
        title={
          enabled ? (
            <>
              Telemetry is <em>flowing</em>.
            </>
          ) : (
            <>
              See <em>everything</em>.
            </>
          )
        }
        description="One toggle. swarmy stands up an OpenTelemetry collector + ClickHouse store, then traces and metrics land here — in your own Jaeger-style view."
        actions={
          <StatusBadge
            tone={heroTone}
            label={
              collectorStatus === 'RUNNING'
                ? storeReachable
                  ? 'Collector live · store reachable'
                  : 'Collector live · store unreachable'
                : collectorStatus === 'DEPLOYING'
                  ? 'Deploying'
                  : collectorStatus === 'FAILED'
                    ? 'Failed'
                    : 'Off'
            }
          />
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="card-pop border-0 lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-base">Observability suite</CardTitle>
            <CardDescription>
              Off by default — zero footprint. Turning it on deploys the collector and ClickHouse as
              swarmy-managed services.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="bg-accent/40 flex items-center justify-between rounded-xl px-4 py-3">
              <div>
                <Label htmlFor="obs-on" className="font-medium">
                  Enabled
                </Label>
                <p className="text-muted-foreground text-xs">Master switch for the whole org.</p>
              </div>
              <Switch
                id="obs-on"
                checked={enabled}
                disabled={setEnabled.isPending || status.isLoading}
                onCheckedChange={(v) => setEnabled.mutate({ enabled: v })}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <StatTile label="Collector" value={collectorStatus.toLowerCase()} />
              <StatTile label="Store" value={storeReachable ? 'reachable' : enabled ? 'pending' : 'off'} />
            </div>

            <div className="bg-muted/50 rounded-xl px-4 py-3">
              <p className="mono-label">Stacks reporting</p>
              <p className="mt-1 text-2xl font-bold">
                <CountUp value={stacksEnabled} />
              </p>
              <p className="text-muted-foreground mt-1 text-xs">
                Enable telemetry per-stack from each stack's page — OTEL env is injected at deploy.
              </p>
            </div>

            {status.data?.storeEndpoint ? (
              <p className="text-muted-foreground mono-data text-xs">store · {status.data.storeEndpoint}</p>
            ) : null}
          </CardContent>
        </Card>

        <div className="grid gap-4 lg:col-span-2">
          <TracesPanel enabled={enabled} />
          <MetricsPanel enabled={enabled} />
        </div>
      </div>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="bg-muted/50 rounded-xl px-4 py-3">
      <p className="mono-label">{label}</p>
      <p className="mono-data mt-1 text-sm font-medium capitalize">{value}</p>
    </div>
  );
}

function TracesPanel({ enabled }: { enabled: boolean }): React.JSX.Element {
  const trpc = useTRPC();
  const [errorsOnly, setErrorsOnly] = React.useState(false);
  const traces = useQuery({
    ...trpc.observability.traces.queryOptions({ windowMinutes: 60, errorsOnly, limit: 100 }),
    enabled,
    refetchInterval: enabled ? 10_000 : false,
  });

  const rows = traces.data?.traces ?? [];

  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-2">
            <ListTreeIcon className="size-4" /> Traces
          </span>
          <label className="text-muted-foreground flex items-center gap-2 text-xs font-normal">
            Errors only
            <Switch checked={errorsOnly} onCheckedChange={setErrorsOnly} />
          </label>
        </CardTitle>
        <CardDescription>Last hour of root spans. A Jaeger-lite list — no embedded Jaeger.</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {!enabled ? (
          <EmptyState
            className="mx-6 mb-6"
            icon={<ActivityIcon />}
            title="Observability is off"
            description="Flip the switch to stand up the collector and start capturing traces."
          />
        ) : traces.isLoading ? (
          <div className="space-y-2 px-6 pb-6">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full rounded-xl" />
            ))}
          </div>
        ) : traces.data?.status === 'unreachable' ? (
          <EmptyState
            className="mx-6 mb-6"
            icon={<ActivityIcon />}
            title="Store unreachable"
            description="The collector is up but ClickHouse isn't answering yet. Give it a moment after first deploy."
          />
        ) : rows.length === 0 ? (
          <EmptyState
            className="mx-6 mb-6"
            icon={<ActivityIcon />}
            title="No traces yet"
            description="Enable telemetry on a stack and send it some traffic — spans will appear here."
          />
        ) : (
          <>
            <div className="text-muted-foreground grid grid-cols-[2fr_1fr_auto_auto] gap-x-4 px-6 pb-2">
              <span className="mono-label">Operation</span>
              <span className="mono-label hidden sm:block">Service</span>
              <span className="mono-label text-right">Spans</span>
              <span className="mono-label text-right">Duration</span>
            </div>
            <div className="border-t">
              {rows.map((t) => (
                <div
                  key={t.span_id}
                  className="hover:bg-accent/60 grid grid-cols-[2fr_1fr_auto_auto] items-center gap-x-4 border-b px-6 py-3 transition-colors last:border-b-0"
                >
                  <div className="min-w-0">
                    <p className="mono-data flex items-center gap-2 truncate font-medium">
                      {t.status_code !== 'STATUS_CODE_OK' ? (
                        <span className="bg-status-offline size-1.5 shrink-0 rounded-full" />
                      ) : null}
                      {t.span_name}
                    </p>
                    <p className="text-muted-foreground mono-label truncate sm:hidden">{t.service_name}</p>
                  </div>
                  <span className="hidden truncate text-sm sm:block">{t.service_name}</span>
                  <span className="mono-data text-right text-sm">{t.span_count}</span>
                  <span className="text-right">
                    <Badge variant="muted">{t.duration_ms} ms</Badge>
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function MetricsPanel({ enabled }: { enabled: boolean }): React.JSX.Element {
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
          <select
            className="border-input bg-background rounded-lg border px-2 py-1 text-xs"
            value={metric}
            onChange={(e) => setMetric(e.target.value)}
          >
            {METRIC_PRESETS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
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
