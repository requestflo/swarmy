import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ResilienceDrillResultView } from '@swarmy/core';
import { Depth, TONE_TEXT, Tech } from '@/components/calm';
import { DRILL_TECH, formatDurationMs, relativeTime } from '@/components/resilience/format';
import { RunDrillDialog } from '@/components/resilience/run-drill-dialog';
import { useTRPC } from '@/integrations/trpc';
import { DrillSteps } from './drill-steps';
import { drillOutcome, stepWords } from './drill-words';
import { useDrillProgress } from './use-drill-progress';
import { VerifyAll } from './verify-all';

/** Whole seconds since `since`, ticking while it is set. */
function useElapsed(since: number | null): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (since == null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [since]);
  return since == null ? 0 : Math.max(0, Math.round((now - since) / 1000));
}

/**
 * The DR drill on /backups (board 16): restore the latest database save into
 * a throwaway copy, check it answers, delete it (`resilience.runRestoreDrill`).
 * While one runs (started here or by anyone in the org) it shows
 * "Running · <step>" and the steps so far, live (`resilience.drillProgress`);
 * otherwise the last run's recorded steps. "Verify all" checks every destination.
 */
export function DrDrillCard({ primary }: { primary: boolean }): React.JSX.Element {
  const trpc = useTRPC();
  const overview = useQuery({ ...trpc.resilience.overview.queryOptions(), refetchInterval: 15_000 });
  const history = useQuery({ ...trpc.resilience.drillHistory.queryOptions({ limit: 20 }), refetchInterval: 30_000 });
  const [pick, setPick] = React.useState<string | null>(null);
  const [startedAt, setStartedAt] = React.useState<number | null>(null);
  const [result, setResult] = React.useState<ResilienceDrillResultView | null>(null);
  const live = useDrillProgress('restore');
  const running = live != null || startedAt != null;
  const elapsed = useElapsed(live?.startedAt ?? startedAt);
  const now = live?.current ? stepWords(live.current.name).toLowerCase() : 'starting';

  const card = overview.data?.drills.find((d) => d.kind === 'restore') ?? null;
  const targets = overview.data?.drillTargets ?? [];
  const restores = (history.data ?? []).filter((h) => h.kind === 'restore');
  // Default to the database the last drill ran on, so the sentence and its steps match.
  const ref = (t: { stack: string; cluster: string }): string => `${t.stack}/${t.cluster}`;
  const target =
    targets.find((t) => ref(t) === (live?.target ?? pick ?? restores[0]?.target)) ?? targets.find((t) => t.healthy) ?? targets[0] ?? null;
  const lastPassed = restores.find((h) => h.status === 'passed');
  const shown = result ?? restores[0] ?? null;
  const eyebrow = running
    ? `DR drill · running for ${elapsed} s`
    : lastPassed
    ? `DR drill · last passed ${relativeTime(lastPassed.at)}`
    : restores[0]
      ? `DR drill · last run failed ${relativeTime(restores[0].at)}`
      : 'DR drill · never run';

  return (
    <section aria-label="Disaster recovery drill" className="calm-card flex flex-col gap-3 px-5 py-4">
      <span className="calm-eyebrow">{eyebrow}</span>
      <h2 className="font-display text-[19px] leading-snug font-bold tracking-[-0.01em]">
        Prove a restore works, without touching production.
      </h2>
      <p className="text-muted-foreground text-[13.5px] leading-relaxed">
        {target
          ? `Restores the latest save of ${target.stack}’s ${target.cluster} database into a throwaway copy, checks it answers, then deletes it.`
          : card?.unavailableReason ?? 'Needs a managed database to restore.'}
      </p>
      <Tech>{DRILL_TECH.restore}</Tech>
      {targets.length > 1 ? (
        <Depth at="controls">
          <label className="flex flex-wrap items-center gap-2 text-[13px]">
            <span className="text-muted-foreground font-semibold">Drill on</span>
            <select
              value={target ? ref(target) : ''}
              onChange={(e) => setPick(e.target.value)}
              className="border-input bg-background h-8 rounded-md border px-2 font-mono text-[12.5px] pointer-coarse:min-h-11"
            >
              {targets.map((t) => (
                <option key={ref(t)} value={ref(t)}>{ref(t)}</option>
              ))}
            </select>
          </label>
        </Depth>
      ) : null}
      {live ? <DrillSteps steps={live.steps} current={live.current} /> : shown ? <DrillSteps steps={shown.steps} dim={running} /> : null}
      {shown && !running ? (
        <div className="flex flex-col gap-0.5 border-t pt-3">
          <span className={`text-[14px] font-semibold ${TONE_TEXT[shown.status === 'passed' ? 'ok' : 'bad']}`}>
            {shown.status === 'passed' ? 'Drill passed' : 'Drill failed'}
            <span className="text-muted-foreground font-mono text-[11.5px] font-normal"> · {relativeTime(shown.at)} · {formatDurationMs(shown.durationMs)}</span>
          </span>
          <span className="text-[13px]">{drillOutcome(shown)}</span>
          <Tech>{shown.status === 'passed' ? 'throwaway copy deleted · logged in audit' : (shown.error ?? shown.summary)}</Tech>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <RunDrillDialog
          kind="restore"
          targets={target ? [target] : []}
          label={running ? `Running · ${now}` : shown ? 'Run again' : 'Run a DR drill'}
          variant={primary ? 'default' : 'outline'}
          disabled={!card?.available || !target || running}
          disabledReason={card?.unavailableReason ?? null}
          onStart={() => {
            setResult(null);
            setStartedAt(Date.now());
          }}
          onResult={(r) => {
            setResult(r);
            setStartedAt(null);
          }}
          onFailed={() => setStartedAt(null)}
        />
      </div>
      <div className="text-muted-foreground flex flex-col gap-1.5 border-t pt-3 text-[13px]">
        <span>Also drill: read every save where it’s kept.</span>
        <VerifyAll />
      </div>
    </section>
  );
}
