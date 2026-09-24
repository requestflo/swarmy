import * as React from 'react';
import { StatusBadge } from '@swarmy/ui';
import { heldActions, purgeablePostgres, type AppPlan } from './gitops-types';
import { PurgeDataDialog } from './purge-data-dialog';
import { PlanActionRow } from './plan-action-row';
import { PlanIssues } from './plan-issues';
import { planStatus } from './plan-status';

/** The plan itself: status, errors, swarmy.yaml issues, then every step with its gate + outcome. */
export function PlanBody({
  plan,
  configPath,
}: {
  plan: AppPlan;
  configPath?: string;
}): React.JSX.Element {
  const held = new Set(heldActions(plan).map((a) => a.id));
  const counts = plan.plan?.counts;
  // purgeData has no "volume still kept" read-back, so hide one once it's deleted here.
  const [purged, setPurged] = React.useState<string[]>([]);
  const purgeable = purgeablePostgres(plan).filter((n) => !purged.includes(n));
  return (
    <div className="space-y-4 px-4 pb-8">
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge {...planStatus(plan.status)} />
        {counts ? (
          <span className="text-muted-foreground mono-label">
            {counts.auto} auto · {counts.confirm} confirm · {counts.blocked} blocked
          </span>
        ) : null}
      </div>
      {plan.error ? <p className="text-status-offline text-sm">{plan.error}</p> : null}
      <PlanIssues issues={plan.issues} configPath={configPath} />
      {plan.plan && plan.plan.actions.length > 0 ? (
        <ul className="card-pop divide-border divide-y overflow-hidden">
          {plan.plan.actions.map((a) => (
            <PlanActionRow
              key={a.id}
              planId={plan.id}
              action={a}
              outcome={plan.outcomes[a.id]}
              confirmable={held.has(a.id) && plan.status === 'needs-confirmation'}
            />
          ))}
        </ul>
      ) : plan.plan ? (
        <p className="text-muted-foreground text-sm">
          Nothing to change — live matches the commit.
        </p>
      ) : null}
      {purgeable.map((name) => (
        <div
          key={name}
          className="border-status-offline/30 flex flex-wrap items-center gap-3 rounded-2xl border px-5 py-4"
        >
          <p className="min-w-0 flex-1 text-sm">
            <span className="mono-data">{name}</span> is gone, but its data volume is still on disk.
          </p>
          <PurgeDataDialog
            repoId={plan.repoId}
            environment={plan.environment}
            stack={plan.stack}
            resource={name}
            onPurged={() => setPurged((p) => [...p, name])}
          />
        </div>
      ))}
    </div>
  );
}
