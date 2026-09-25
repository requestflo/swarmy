import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlreadyOn, Depth, SayHeader } from '@/components/calm';
import { PageSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { StackStatusPages } from '@/components/statuspages/stack-status-pages';
import { HealthReasonsPanel } from './health-reasons';
import { LogsPanel } from './logs-panel';
import { MetricsPanel } from './metrics-panel';
import { ObsCode } from './obs-code';
import { ObsNextAction, obsHeadline, type ObsState } from './obs-summary';
import { ServiceMapPanel } from './service-map';
import { ServiceMetricsPanel } from './service-metrics-panel';
import { StackOtelHero } from './stack-otel-hero';
import { TracesPanel } from './traces-panel';
import type { CollectorStatus } from './observability-shared';

/**
 * The app's Logs & traces tab (Logs + ObsSettings boards). Summary: one
 * sentence from the health narrative, the one next action, what swarmy
 * watches. Controls: the collector switches, service map, traces, metrics,
 * logs and status pages. Code: the injected OTEL_* env, `swarmy logs`, REST.
 */
export function StackObservabilityTab({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const status = useQuery({ ...trpc.observability.status.queryOptions(), refetchInterval: 5_000 });
  const telemetry = useQuery(trpc.observability.stackTelemetry.queryOptions({ stack }));
  const health = useQuery({ ...trpc.observability.health.queryOptions({ stack }), refetchInterval: 10_000 });

  if (status.isPending || telemetry.isPending) return <PageSkeleton className="px-0 pt-0 xl:px-0" />;

  const enabled = !!status.data?.enabled;
  const appOn = !!telemetry.data?.enabled;
  const state: ObsState = !enabled ? 'suite-off' : !appOn ? 'app-off' : 'on';
  const collectorStatus = (status.data?.collectorStatus ?? 'OFFLINE') as CollectorStatus;
  const storeReachable = !!status.data?.storeReachable;
  const retention = status.data?.retentionDays;
  const head = obsHeadline(stack, state, health.data, retention);
  const bad = health.data && (health.data.status === 'degraded' || health.data.status === 'down');
  const real = bad ? (health.data?.reasons ?? []).filter((r) => !r.startsWith('telemetry')) : [];
  const reason = real.find((r) => /error|latency|p95/i.test(r)) ?? real[0] ?? null;

  return (
    <div className="flex flex-col gap-5 pb-8">
      <SayHeader size="md" title={head.title} lede={head.lede} />
      <ObsCode stack={stack} enabled={appOn} />
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <HealthReasonsPanel stack={stack} />
        <div className="flex min-w-0 flex-col gap-5">
          <ObsNextAction stack={stack} state={state} reason={reason} />
          {state === 'on' ? (
            <AlreadyOn
              items={[
                { what: 'Traces', detail: 'every request, end to end' },
                { what: 'Logs', detail: 'every service, searchable' },
                { what: 'Metrics', detail: 'latency, errors and traffic' },
                { what: 'Kept', detail: retention ? `${retention} days, then dropped` : 'on the store’s schedule' },
              ]}
            />
          ) : null}
        </div>
      </div>
      <Depth at="controls">
        <StackOtelHero stack={stack} suiteEnabled={enabled} collectorStatus={collectorStatus} storeReachable={storeReachable} statusLoading={status.isLoading} retentionDays={retention} />
        <ServiceMapPanel enabled={enabled} stack={stack} />
        <div id="traces" className="grid scroll-mt-4 gap-4 xl:grid-cols-2">
          <TracesPanel enabled={enabled} stack={stack} />
          <div className="grid gap-4">
            <MetricsPanel enabled={enabled} stack={stack} />
            <ServiceMetricsPanel enabled={enabled} stack={stack} />
          </div>
        </div>
        <div id="logs" className="scroll-mt-4">
          <LogsPanel enabled={enabled} stack={stack} />
        </div>
        <StackStatusPages stack={stack} suiteEnabled={enabled} />
      </Depth>
    </div>
  );
}
