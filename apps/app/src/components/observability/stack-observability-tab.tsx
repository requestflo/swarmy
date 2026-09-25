import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { StackStatusPages } from '@/components/statuspages/stack-status-pages';
import { HealthReasonsPanel } from './health-reasons';
import { LogsPanel } from './logs-panel';
import { MetricsPanel } from './metrics-panel';
import { ServiceMapPanel } from './service-map';
import { ServiceMetricsPanel } from './service-metrics-panel';
import { StackOtelHero } from './stack-otel-hero';
import { TracesPanel } from './traces-panel';
import type { CollectorStatus } from './observability-shared';

interface StackObservabilityTabProps {
  stack: string;
}

/**
 * The stack workspace Observability tab: collector status + this stack's
 * telemetry opt-in up top, then the health narrative, service map, traces,
 * metrics and logs — every query scoped to this stack — and the stack's
 * public status page(s) at the bottom.
 */
export function StackObservabilityTab({ stack }: StackObservabilityTabProps): React.JSX.Element {
  const trpc = useTRPC();
  const status = useQuery({ ...trpc.observability.status.queryOptions(), refetchInterval: 5_000 });

  const enabled = !!status.data?.enabled;
  const collectorStatus = (status.data?.collectorStatus ?? 'OFFLINE') as CollectorStatus;
  const storeReachable = !!status.data?.storeReachable;

  return (
    <div className="pb-8">
      <StackOtelHero
        stack={stack}
        suiteEnabled={enabled}
        collectorStatus={collectorStatus}
        storeReachable={storeReachable}
        statusLoading={status.isLoading}
      />

      <HealthReasonsPanel stack={stack} />
      <ServiceMapPanel enabled={enabled} stack={stack} />

      <div className="grid gap-4 xl:grid-cols-2">
        <TracesPanel enabled={enabled} stack={stack} />
        <div className="grid gap-4">
          <MetricsPanel enabled={enabled} stack={stack} />
          <ServiceMetricsPanel enabled={enabled} stack={stack} />
        </div>
      </div>

      <div className="mt-4">
        <LogsPanel enabled={enabled} stack={stack} />
      </div>

      <div className="mt-4">
        <StackStatusPages stack={stack} suiteEnabled={enabled} />
      </div>
    </div>
  );
}
