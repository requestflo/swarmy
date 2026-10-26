import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { InvService, ServiceDetail } from '@swarmy/core';
import { toast } from '@swarmy/ui';
import { Depth, Tech } from '@/components/calm';
import { QuietSwitch } from '@/components/rowpage/row-page';
import { Segmented } from '@/components/service-settings/settings-row';
import { useTRPC } from '@/integrations/trpc';
import { SleepChart } from './sleep-chart';
import { IDLE_PRESETS, idleWords, simulateSleep } from './sleep-sim';
import { sleepDayWords, sleepNowWords } from './sleep-words';
import { useSleepSeries } from './use-sleep-series';
import { WakeLine } from './wake-line';

/**
 * Sleep when idle (`services.setScaleToZero`, a label, applied at once), and
 * yesterday replayed through the chosen idle time. Before it's on, the idle
 * choice only changes the replay; switching on applies it.
 */
export function SleepBlock({
  stack,
  inv,
  detail,
  name,
  address,
}: {
  stack: string;
  inv: InvService;
  detail: ServiceDetail | null | undefined;
  name: string;
  address: string | null | undefined;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const s2z = detail?.scaleToZero;
  const enabled = s2z?.enabled ?? inv.scaleToZero;
  const [idleSec, setIdleSec] = React.useState<number>(enabled && s2z ? s2z.idleSeconds : 900);
  // The live label wins once it's read (and after every change).
  React.useEffect(() => {
    if (s2z?.enabled) setIdleSec(s2z.idleSeconds);
  }, [s2z?.enabled, s2z?.idleSeconds]);
  const set = useMutation(
    trpc.services.setScaleToZero.mutationOptions({ onSuccess: () => void qc.invalidateQueries(), onError: (e) => toast.error(e.message) }),
  );
  const apply = (on: boolean, idle: number): void =>
    set.mutate({ id: inv.id, enabled: on, idleSeconds: idle, ...(s2z?.enabled ? { targetReplicas: s2z.targetReplicas } : {}) });
  const series = useSleepSeries(stack, inv);
  const sim = React.useMemo(
    () => (series.status === 'ok' ? simulateSleep({ ...series, idleMs: idleSec * 1000 }) : null),
    [series, idleSec],
  );
  const presets = [...new Set<number>([...IDLE_PRESETS, idleSec])].sort((a, b) => a - b);
  const addr = address ?? null;
  const day = sim ? sleepDayWords({ name, sim, idleSec, address: addr }) : null;
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-3">
        <h3 className="flex flex-1 flex-wrap items-baseline gap-x-2 text-[13.5px] font-semibold">
          Sleep when idle
          <Depth at="controls">
            <span className="text-muted-foreground font-mono text-[11px] font-normal">sleep_after</span>
          </Depth>
        </h3>
        <Depth at="controls">
          <QuietSwitch aria-label="Sleep when idle" checked={enabled} disabled={set.isPending} onCheckedChange={(v) => v !== enabled && apply(v, idleSec)} />
        </Depth>
      </div>
      <p className="text-[13.5px] leading-relaxed">
        {address === undefined ? null : sleepNowWords({ name, enabled, asleep: enabled && inv.replicas.desired === 0, idleSec: s2z?.idleSeconds ?? idleSec, address: addr })}
      </p>
      <Depth at="controls">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-[12.5px]">after</span>
          <Segmented
            label="Idle time before it sleeps"
            mono
            options={presets.map((v) => ({ value: v, label: idleWords(v) }))}
            value={idleSec}
            disabled={set.isPending}
            onChange={(v) => {
              setIdleSec(v);
              if (enabled && v !== s2z?.idleSeconds) apply(true, v);
            }}
          />
        </div>
      </Depth>
      {enabled ? <WakeLine id={inv.id} address={addr} /> : null}
      <span className="text-muted-foreground mt-1 font-mono text-[11px] tracking-[0.08em] uppercase">Yesterday, if it had slept</span>
      {series.status === 'pending' ? (
        <div aria-hidden className="shimmer-line h-16 rounded-md" />
      ) : series.status === 'disabled' ? (
        <p className="text-muted-foreground text-[13px]">
          No chart: telemetry is off for {stack}, so swarmy can’t see {name}’s requests.{' '}
          <Link to="/stacks/$name/observability" params={{ name: stack }} className="text-primary font-mono text-[11.5px] hover:underline">
            Turn it on →
          </Link>
        </p>
      ) : series.status === 'unreachable' ? (
        <p className="text-muted-foreground text-[13px]">No chart: the telemetry store isn’t answering.</p>
      ) : sim && sim.calls > 0 ? (
        <SleepChart slots={sim.slots} label={day ?? ''} />
      ) : null}
      {day ? <p className="text-muted-foreground text-[13px] leading-relaxed">{day}</p> : null}
      <Tech>
        {enabled ? `swarmy.scaleToZero.enabled=true · idleSeconds=${s2z?.idleSeconds ?? '—'} · targetReplicas=${s2z?.targetReplicas ?? '—'}` : 'swarmy.scaleToZero.* unset (off)'}
        {` · replay: observability.requestSeries 5-minute buckets, idle ${idleSec}s`}
      </Tech>
    </div>
  );
}
