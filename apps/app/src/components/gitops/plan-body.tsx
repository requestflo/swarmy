import * as React from 'react';
import { StatusBadge } from '@swarmy/ui';
import { heldActions, type AppPlan } from './gitops-types';
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
    </div>
  );
}
