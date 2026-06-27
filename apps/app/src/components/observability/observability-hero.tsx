import * as React from 'react';
import { Card, Label, StatusBadge, Switch, cn } from '@swarmy/ui';
import { CountUp } from '@/components/count-up';
import { heroTone, type CollectorStatus } from './observability-shared';

interface ObservabilityHeroProps {
  enabled: boolean;
  collectorStatus: CollectorStatus;
  storeReachable: boolean;
  stacksEnabled: number;
  storeEndpoint: string | null;
  toggleDisabled: boolean;
  onToggle: (enabled: boolean) => void;
}

/** KPI strip — leads with numbers, then the master switch + store wiring. */
export function ObservabilityHero({
  enabled,
  collectorStatus,
  storeReachable,
  stacksEnabled,
  storeEndpoint,
  toggleDisabled,
  onToggle,
}: ObservabilityHeroProps): React.JSX.Element {
  return (
    <div className="mb-4 grid gap-4 lg:grid-cols-4">
      <Kpi label="Stacks reporting" hero>
        <CountUp value={stacksEnabled} />
      </Kpi>

      <Kpi
        label="Collector"
        tone={heroTone(collectorStatus, storeReachable)}
        toneLabel={collectorStatus.toLowerCase()}
      >
        {collectorStatus.toLowerCase()}
      </Kpi>

      <Kpi
        label="Store"
        tone={enabled ? (storeReachable ? 'online' : 'progress') : 'neutral'}
        toneLabel={storeReachable ? 'reachable' : enabled ? 'pending' : 'off'}
      >
        {storeReachable ? 'reachable' : enabled ? 'pending' : 'off'}
      </Kpi>

      <Card className="card-pop flex flex-col justify-between gap-3 border-0 p-5">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="obs-on" className="text-sm font-semibold">
            Observability suite
          </Label>
          <Switch id="obs-on" checked={enabled} disabled={toggleDisabled} onCheckedChange={onToggle} />
        </div>
        <p className="text-muted-foreground text-xs">
          {enabled
            ? 'Collector + ClickHouse are swarmy-managed. Flip per-stack telemetry on each stack page.'
            : 'Off by default — zero footprint. Turning it on deploys the collector + ClickHouse.'}
        </p>
        {storeEndpoint ? (
          <p className="text-muted-foreground mono-data truncate text-[0.7rem]">store · {storeEndpoint}</p>
        ) : null}
      </Card>
    </div>
  );
}

interface KpiProps {
  label: string;
  children: React.ReactNode;
  hero?: boolean;
  tone?: React.ComponentProps<typeof StatusBadge>['tone'];
  toneLabel?: string;
}

function Kpi({ label, children, hero, tone, toneLabel }: KpiProps): React.JSX.Element {
  return (
    <Card className="card-pop flex flex-col gap-2 border-0 p-5">
      <p className="mono-label">{label}</p>
      <p
        className={cn(
          'mono-data font-bold capitalize tabular-nums',
          hero ? 'text-4xl' : 'text-2xl',
        )}
      >
        {children}
      </p>
      {tone && toneLabel ? <StatusBadge tone={tone} label={toneLabel} className="capitalize" /> : null}
    </Card>
  );
}
