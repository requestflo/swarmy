import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Input, StatusBadge, cn, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { OtelStackToggle } from '@/components/stacks/otel-stack-toggle';
import { heroLabel, heroTone, type CollectorStatus } from './observability-shared';

interface StackOtelHeroProps {
  stack: string;
  /** Whether the org-wide observability suite (collector + store) is on. */
  suiteEnabled: boolean;
  collectorStatus: CollectorStatus;
  storeReachable: boolean;
  statusLoading: boolean;
  /** How long the store keeps traces, metrics and logs (org-wide). */
  retentionDays?: number;
}

/**
 * The tab hero: collector + store state as KPIs, and the two switches that
 * matter — the org-wide suite (when it's still off) and this stack's own
 * telemetry opt-in (the `swarmy.otel.enabled` label, applied on next deploy).
 */
export function StackOtelHero({
  stack,
  suiteEnabled,
  collectorStatus,
  storeReachable,
  statusLoading,
  retentionDays,
}: StackOtelHeroProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const telemetry = useQuery(trpc.observability.stackTelemetry.queryOptions({ stack }));
  const stackOn = telemetry.data?.enabled ?? false;

  const setEnabled = useMutation(
    trpc.observability.setEnabled.mutationOptions({
      onSuccess: () => {
        toast.success('Observability is coming up — collector + store are deploying');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Kpi
        label="This stack"
        tone={stackOn ? 'online' : 'neutral'}
        toneLabel={stackOn ? 'telemetry on' : 'telemetry off'}
      >
        {telemetry.isLoading ? '…' : stackOn ? 'on' : 'off'}
      </Kpi>
      <Kpi
        label="Collector"
        tone={heroTone(collectorStatus, storeReachable)}
        toneLabel={heroLabel(collectorStatus, storeReachable)}
      >
        {collectorStatus.toLowerCase()}
      </Kpi>
      <Kpi
        label="Store"
        tone={suiteEnabled ? (storeReachable ? 'online' : 'progress') : 'neutral'}
        toneLabel={storeReachable ? 'reachable' : suiteEnabled ? 'pending' : 'off'}
      >
        {storeReachable ? 'reachable' : suiteEnabled ? 'pending' : 'off'}
      </Kpi>

      <Card className="card-pop flex flex-col justify-between gap-3 border-0 p-5">
        {suiteEnabled ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-semibold">Ship telemetry</p>
              <OtelStackToggle stack={stack} />
            </div>
            <p className="text-muted-foreground text-xs">
              Flip it on and <span className="mono-data">{stack}</span> gets OTEL_* env injected on
              its next deploy — traces, metrics and logs land on this page.
            </p>
            {retentionDays != null && <RetentionControl days={retentionDays} />}
          </>
        ) : (
          <>
            <p className="text-sm font-semibold">Observability is off</p>
            <p className="text-muted-foreground text-xs">
              One switch deploys an OpenTelemetry collector + ClickHouse store, swarmy-managed.
              Then opt this stack in.
            </p>
            <Button
              size="sm"
              disabled={statusLoading || setEnabled.isPending}
              onClick={() => setEnabled.mutate({ enabled: true })}
            >
              {setEnabled.isPending ? 'Turning on…' : 'Turn on observability'}
            </Button>
          </>
        )}
      </Card>
    </div>
  );
}

/** Org-wide: how many days the store keeps telemetry (and error events). */
function RetentionControl({ days }: { days: number }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [draft, setDraft] = React.useState(String(days));
  React.useEffect(() => setDraft(String(days)), [days]);
  const save = useMutation(
    trpc.observability.setRetention.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Telemetry kept for ${r.retentionDays} days`);
        void qc.invalidateQueries({ queryKey: trpc.observability.status.queryKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const n = Number(draft);
  const valid = Number.isInteger(n) && n >= 1 && n <= 365;
  return (
    <form
      className="flex items-center gap-2 text-xs"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && n !== days) save.mutate({ retentionDays: n });
      }}
    >
      <label htmlFor="obs-retention" className="text-muted-foreground">
        Keep for
      </label>
      <Input
        id="obs-retention"
        type="number"
        min={1}
        max={365}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="h-7 w-16 px-2 text-xs"
      />
      <span className="text-muted-foreground">days (all stacks)</span>
      {valid && n !== days && (
        <Button type="submit" size="sm" variant="outline" className="h-7 px-2" disabled={save.isPending}>
          Save
        </Button>
      )}
    </form>
  );
}

interface KpiProps {
  label: string;
  children: React.ReactNode;
  tone?: React.ComponentProps<typeof StatusBadge>['tone'];
  toneLabel?: string;
}

function Kpi({ label, children, tone, toneLabel }: KpiProps): React.JSX.Element {
  return (
    <Card className="card-pop flex flex-col gap-2 border-0 p-5">
      <p className="mono-label">{label}</p>
      <p className={cn('mono-data text-2xl font-bold capitalize tabular-nums')}>{children}</p>
      {tone && toneLabel ? <StatusBadge tone={tone} label={toneLabel} className="capitalize" /> : null}
    </Card>
  );
}
