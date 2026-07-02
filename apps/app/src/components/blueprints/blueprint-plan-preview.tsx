import * as React from 'react';
import { Loader2Icon } from 'lucide-react';
import type { BlueprintPlanView } from '@swarmy/core';
import { Button } from '@swarmy/ui';

/** Step 2 of the wizard: the dry-run — exactly what deploy will create. */
export function BlueprintPlanPreview({
  plan,
  loading,
  error,
  onBack,
  onDeploy,
  deploying,
}: {
  plan: BlueprintPlanView | undefined;
  loading: boolean;
  error: string | null;
  onBack: () => void;
  onDeploy: () => void;
  deploying: boolean;
}): React.JSX.Element {
  if (loading) {
    return (
      <div className="space-y-2 py-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="shimmer-line h-10 rounded-lg" />
        ))}
      </div>
    );
  }
  if (error || !plan) {
    return (
      <div className="space-y-3 py-2">
        <p className="text-status-offline text-sm">{error ?? "Couldn't build the plan."}</p>
        <Button variant="outline" className="rounded-full font-bold" onClick={onBack}>
          Back
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <p className="text-sm font-medium">{plan.summary}</p>
      <ol className="divide-border divide-y rounded-xl border">
        {plan.steps.map((step, i) => (
          <li key={`${step.kind}-${i}`} className="flex items-start gap-3 px-3 py-2.5">
            <span className="mono-data text-muted-foreground pt-0.5 text-xs">{i + 1}</span>
            <div className="min-w-0">
              <p className="text-sm font-medium">{step.label}</p>
              <p className="mono-data text-muted-foreground truncate text-[11px]">
                {Object.entries(step.detail)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(' · ')}
              </p>
            </div>
          </li>
        ))}
      </ol>
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" className="rounded-full font-bold" onClick={onBack} disabled={deploying}>
          Back
        </Button>
        <Button className="rounded-full font-bold" onClick={onDeploy} disabled={deploying}>
          {deploying ? (
            <>
              <Loader2Icon className="size-4 animate-spin" /> Deploying…
            </>
          ) : (
            `Deploy ${plan.stackName}`
          )}
        </Button>
      </div>
    </div>
  );
}
