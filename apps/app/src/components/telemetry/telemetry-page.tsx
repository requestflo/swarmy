import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@swarmy/ui';
import { projectTelemetryForecast } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { CodeView } from '@/components/calm';
import { ErrorState, SkeletonBody } from '@/components/states';
import { RowPage } from '@/components/rowpage/row-page';
import { duration, forecastLine, keepPhrase, telemetryCode } from './telemetry-copy';
import { TelemetryApply } from './telemetry-apply';
import { TelemetryApps } from './telemetry-apps';
import { TelemetryForecast } from './telemetry-forecast';
import { TelemetryKeep } from './telemetry-keep';
import { TelemetryPipeline } from './telemetry-pipeline';
import { TelemetryRedaction } from './telemetry-redaction';
import { useTelemetryApps } from './use-telemetry-apps';
import { useTelemetryDraft } from './use-telemetry-draft';

/** Activity → Telemetry: which apps send it, what the collector keeps, for how long, and what it scrubs. */
export function TelemetryPage(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const view = useQuery({ ...trpc.observability.settings.queryOptions(), refetchInterval: (q) => (q.state.data?.applied === false && q.state.data.suiteEnabled ? 3_000 : 30_000) });
  const forecast = useQuery({ ...trpc.observability.forecast.queryOptions(), refetchInterval: 60_000 });
  const pipeline = useQuery({ ...trpc.observability.pipeline.queryOptions(), refetchInterval: 10_000 });
  const turnOn = useMutation(trpc.observability.setEnabled.mutationOptions({ onSuccess: () => qc.invalidateQueries() }));
  const apps = useTelemetryApps();
  const draft = useTelemetryDraft(view.data?.settings);
  const s = draft.current;
  const projection = React.useMemo(() => (forecast.data && s ? projectTelemetryForecast(forecast.data, s) : null), [forecast.data, s]);

  if (view.isError) return <RowPage title="Telemetry."><ErrorState title="Couldn’t load telemetry settings." error={view.error} retry={() => void view.refetch()} /></RowPage>;
  if (!view.data || !s) return <RowPage title="Telemetry."><SkeletonBody variant="list" /></RowPage>;

  const suiteOn = view.data.suiteEnabled;
  const total = apps.apps?.length;
  const title = !suiteOn ? (
    <>
      Telemetry is off. <em>Turn it on to keep traces, logs and metrics.</em>
    </>
  ) : (
    <>
      Telemetry is on for {total === undefined ? '…' : `${apps.onCount} of ${total}`} apps.{' '}
      <em>It keeps {keepPhrase(s)}.</em>
    </>
  );
  const line = projection && forecast.data ? forecastLine(s, projection, forecast.data.node, forecast.data.freeBytes) : null;
  const slow = s.sampling.restPercent < 100 && s.sampling.slowTraceMs !== null ? ` Traces slower than ${duration(s.sampling.slowTraceMs)} are always kept too.` : '';
  const lede = `Traces are kept ${s.retention.tracesDays} days, logs ${s.retention.logsDays} and metrics ${s.retention.metricsDays}.${slow}${line ? ` ${line}` : ''}`;
  const status = pipeline.data?.collector.status;

  return (
    <RowPage
      title={title}
      description={lede}
      actions={
        !suiteOn ? (
          <Button onClick={() => turnOn.mutate({ enabled: true })} disabled={turnOn.isPending} className="pointer-coarse:min-h-11">
            {turnOn.isPending ? 'Turning on…' : 'Turn on telemetry'}
          </Button>
        ) : status ? (
          <span className={status === 'RUNNING' ? 'text-tone-ok text-xs font-semibold' : 'text-tone-warn text-xs font-semibold'}>
            {status === 'RUNNING' ? 'Collector running · live' : status === 'DEPLOYING' ? 'Collector starting' : 'Collector not running'}
          </span>
        ) : null
      }
    >
      <div className="grid items-start gap-5 xl:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-5">
          <TelemetryApps {...apps} disabled={!suiteOn} />
          <TelemetryPipeline pipeline={pipeline.data} />
          <TelemetryRedaction rules={s.redaction} onChange={(redaction) => draft.change((c) => ({ ...c, redaction }))} />
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <CodeView title="Telemetry as code" tabs={telemetryCode(s)} source="readonly" note="Dashboard setting · no REST yet. The processors are rendered from these settings by the same code the collector config uses." />
          <TelemetryKeep s={s} change={draft.change} />
          <TelemetryForecast f={forecast.data} p={projection} s={s} />
          <TelemetryApply draft={draft} view={view.data} quiet={!suiteOn} />
        </div>
      </div>
    </RowPage>
  );
}
