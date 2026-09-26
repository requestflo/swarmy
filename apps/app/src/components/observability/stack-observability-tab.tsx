import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Depth, SayHeader } from '@/components/calm';
import { PageSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { LogsView } from './logs-view';
import { ObsCode } from './obs-code';
import { ObsHealthBlock } from './obs-health-block';
import { ObsNextAction, obsOffHeadline, type ObsState } from './obs-summary';
import type { CollectorStatus } from './observability-shared';

/**
 * The app's Observability › Logs & traces tab (Logs board). It opens on the
 * live log stream; the health dashboard (what swarmy watches, collector
 * switches, service map, traces, metrics) sits under it from Controls.
 * While telemetry is off: the sentence, the one switch, and the same block.
 */
export function StackObservabilityTab({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const status = useQuery({ ...trpc.observability.status.queryOptions(), refetchInterval: 5_000 });
  const telemetry = useQuery(trpc.observability.stackTelemetry.queryOptions({ stack }));

  if (status.isPending || telemetry.isPending) return <PageSkeleton className="px-0 pt-0 xl:px-0" />;

  const enabled = !!status.data?.enabled;
  const appOn = !!telemetry.data?.enabled;
  const state: ObsState = !enabled ? 'suite-off' : !appOn ? 'app-off' : 'on';
  const retention = status.data?.retentionDays;
  const health = (
    <ObsHealthBlock
      stack={stack}
      enabled={enabled}
      collectorStatus={(status.data?.collectorStatus ?? 'OFFLINE') as CollectorStatus}
      storeReachable={!!status.data?.storeReachable}
      statusLoading={status.isLoading}
      retentionDays={retention}
    />
  );

  if (state === 'on') return <LogsView stack={stack} retentionDays={retention}>{health}</LogsView>;

  const head = obsOffHeadline(stack, state);
  return (
    <div className="flex flex-col gap-5 pb-8">
      <SayHeader size="md" title={head.title} lede={head.lede} />
      <Depth at="code">
        <ObsCode stack={stack} enabled={false} />
      </Depth>
      <ObsNextAction stack={stack} state={state} />
      <Depth at="controls">{health}</Depth>
    </div>
  );
}
