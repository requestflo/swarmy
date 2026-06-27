import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, StatusBadge, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { ObservabilityHero } from '@/components/observability/observability-hero';
import { TracesPanel } from '@/components/observability/traces-panel';
import { MetricsPanel } from '@/components/observability/metrics-panel';
import { ServiceMetricsPanel } from '@/components/observability/service-metrics-panel';
import { heroLabel, heroTone, type CollectorStatus } from '@/components/observability/observability-shared';

export const Route = createFileRoute('/_authed/observability')({
  component: ObservabilityPage,
});

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

  const collectorStatus = (status.data?.collectorStatus ?? 'OFFLINE') as CollectorStatus;
  const storeReachable = !!status.data?.storeReachable;
  const stacksEnabled = status.data?.stacksEnabled ?? 0;
  const toggleDisabled = setEnabled.isPending || status.isLoading;

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Observability"
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
        description="One toggle stands up an OpenTelemetry collector + ClickHouse store — then traces and metrics land here, in your own Jaeger-style view."
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge tone={heroTone(collectorStatus, storeReachable)} label={heroLabel(collectorStatus, storeReachable)} />
            {enabled ? (
              <Button variant="outline" disabled={toggleDisabled} onClick={() => setEnabled.mutate({ enabled: false })}>
                Turn off
              </Button>
            ) : (
              <Button disabled={toggleDisabled} onClick={() => setEnabled.mutate({ enabled: true })}>
                Turn on observability
              </Button>
            )}
          </div>
        }
      />

      <ObservabilityHero
        enabled={enabled}
        collectorStatus={collectorStatus}
        storeReachable={storeReachable}
        stacksEnabled={stacksEnabled}
        storeEndpoint={status.data?.storeEndpoint ?? null}
        toggleDisabled={toggleDisabled}
        onToggle={(v) => setEnabled.mutate({ enabled: v })}
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <TracesPanel enabled={enabled} />
        <div className="grid gap-4">
          <MetricsPanel enabled={enabled} />
          <ServiceMetricsPanel enabled={enabled} />
        </div>
      </div>
    </div>
  );
}
