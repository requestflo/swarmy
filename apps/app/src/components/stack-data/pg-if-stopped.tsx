import * as React from 'react';
import { Tech } from '@/components/calm';
import { ifStoppedSteps, type HaChoice, type PgBackupFacts, type PgClusterFacts } from './pg-choices';

/** "If the main server stopped right now" — the chosen shape's steps, in plain words. */
export function PgIfStopped({
  cluster,
  backup,
  choice,
}: {
  cluster: PgClusterFacts;
  backup: PgBackupFacts | null;
  choice: HaChoice;
}): React.JSX.Element {
  const steps = ifStoppedSteps(choice, cluster, backup);
  const lag = cluster.maxLagSeconds;
  return (
    <section aria-label="If the main server stopped" className="calm-card flex flex-col gap-3 px-5 py-4">
      <h2 className="font-display text-[16.5px] font-bold tracking-[-0.01em]">
        If {cluster.name}’s main server stopped right now
      </h2>
      <ol className="flex list-decimal flex-col gap-2 pl-5 text-[13.5px] leading-relaxed">
        {steps.map((s) => (
          <li key={s.lead}>
            <b className="font-semibold">{s.lead}</b> <span className="text-muted-foreground">{s.rest}</span>
          </li>
        ))}
      </ol>
      {choice !== 'one' ? (
        <Tech>
          {lag !== undefined ? `lag now ${lag} s` : 'lag not measured yet'} · promote refuses while bytes behind &gt; 0 · the
          old writer’s PGDATA is moved aside, never deleted
        </Tech>
      ) : (
        <Tech>restore = clone-to-new-cluster or in-place from the latest restic snapshot{backup?.pitr ? ' + WAL replay' : ''}</Tech>
      )}
    </section>
  );
}
