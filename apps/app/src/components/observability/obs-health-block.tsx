import * as React from 'react';
import { HealthReasonsPanel } from './health-reasons';
import { MetricsPanel } from './metrics-panel';
import { ServiceMapPanel } from './service-map';
import { ServiceMetricsPanel } from './service-metrics-panel';
import { StackOtelHero } from './stack-otel-hero';
import { TracesPanel } from './traces-panel';
import type { CollectorStatus } from './observability-shared';

interface ObsHealthBlockProps {
  stack: string;
  enabled: boolean;
  collectorStatus: CollectorStatus;
  storeReachable: boolean;
  statusLoading: boolean;
  retentionDays: number | undefined;
}

/**
 * The app's health dashboard, under the stream from Controls: what swarmy
 * watches, the collector switches, the service map, recent traces and the
 * latency / per-part metrics. It used to open the tab; the stream does now.
 */
export function ObsHealthBlock(p: ObsHealthBlockProps): React.JSX.Element {
  return (
    <section id="health" aria-labelledby="obs-health" className="flex scroll-mt-4 flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="obs-health" className="font-display text-[19px] font-bold tracking-[-0.01em]">Health</h2>
        <p className="text-muted-foreground text-[14px]">What swarmy watches for {p.stack}, where requests go and how fast they are.</p>
      </div>
      <HealthReasonsPanel stack={p.stack} />
      <StackOtelHero stack={p.stack} suiteEnabled={p.enabled} collectorStatus={p.collectorStatus} storeReachable={p.storeReachable} statusLoading={p.statusLoading} retentionDays={p.retentionDays} />
      <ServiceMapPanel enabled={p.enabled} stack={p.stack} />
      <div id="traces" className="grid scroll-mt-4 gap-4 xl:grid-cols-2">
        <TracesPanel enabled={p.enabled} stack={p.stack} />
        <div className="grid gap-4">
          <MetricsPanel enabled={p.enabled} stack={p.stack} />
          <ServiceMetricsPanel enabled={p.enabled} stack={p.stack} />
        </div>
      </div>
    </section>
  );
}
