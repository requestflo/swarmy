import * as React from 'react';
import { StatusBadge, cn } from '@swarmy/ui';
import { heldActions, type AppPlan } from './gitops-types';
import { PlanActionRow } from './plan-action-row';
import { PlanGraph } from './plan-graph';
import { PlanIssues } from './plan-issues';
import { planStatus } from './plan-status';

type View = 'list' | 'graph';

/**
 * The plan itself: status, errors, swarmy.yaml issues, then every step with
 * its gate + outcome — as a list, or drawn over the app's graph.
 */
export function PlanBody({
  plan,
  configPath,
}: {
  plan: AppPlan;
  configPath?: string;
}): React.JSX.Element {
  const [view, setView] = React.useState<View>('list');
  const held = new Set(heldActions(plan).map((a) => a.id));
  const actions = plan.plan?.actions ?? [];
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
        {actions.length > 0 ? (
          <div role="tablist" aria-label="Plan view" className="bg-muted ml-auto inline-flex gap-0.5 rounded-full p-0.5">
            {(['list', 'graph'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                onClick={() => setView(v)}
                className={cn(
                  'rounded-full px-3 py-1 text-xs font-semibold capitalize pointer-coarse:min-h-11',
                  view === v ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {v}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {plan.error ? <p className="text-tone-bad text-sm">{plan.error}</p> : null}
      <PlanIssues issues={plan.issues} configPath={configPath} />
      {actions.length > 0 && view === 'graph' ? (
        <PlanGraph stack={plan.stack} actions={actions} />
      ) : actions.length > 0 ? (
        <ul className="card-pop divide-border divide-y overflow-hidden">
          {actions.map((a) => (
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
