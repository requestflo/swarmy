import * as React from 'react';
import { Loader2Icon } from 'lucide-react';
import type { BlueprintPlanView } from '@swarmy/core';
import { Button } from '@swarmy/ui';

/**
 * Step 2 of the wizard: the dry-run — exactly what deploy will create.
 * Lives inside a gallery card, so everything wraps (`min-w-0` + `break-all`
 * on mono values) and the action row can never push the confirm button out
 * of view at any card width.
 */
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
        <p className="text-status-offline text-sm break-words">
          {error ?? "Couldn't build the plan."}
        </p>
        <Button variant="outline" className="rounded-full font-bold" onClick={onBack}>
          Back
        </Button>
      </div>
    );
  }
  return (
    <div className="min-w-0 space-y-4">
      <p className="text-sm font-medium break-words">{plan.summary}</p>
      <ol className="divide-border min-w-0 divide-y overflow-hidden rounded-xl border">
        {plan.steps.map((step, i) => (
          <li key={`${step.kind}-${i}`} className="flex min-w-0 items-start gap-3 px-3 py-2.5">
            <span className="mono-data text-muted-foreground shrink-0 pt-0.5 text-xs">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium break-words">{step.label}</p>
              <p className="mono-data text-muted-foreground text-[11px] leading-relaxed break-all">
                {Object.entries(step.detail).map(([k, v], j) => (
                  <React.Fragment key={k}>
                    {j > 0 ? <span className="text-border mx-1">·</span> : null}
                    <span className="text-foreground/70">{k}=</span>
                    {v}
                  </React.Fragment>
                ))}
              </p>
            </div>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="ghost"
          className="rounded-full font-bold"
          onClick={onBack}
          disabled={deploying}
        >
          Back
        </Button>
        <Button
          className="max-w-full min-w-0 rounded-full font-bold"
          onClick={onDeploy}
          disabled={deploying}
        >
          {deploying ? (
            <>
              <Loader2Icon className="size-4 animate-spin" /> Deploying…
            </>
          ) : (
            <span className="truncate">Deploy {plan.stackName}</span>
          )}
        </Button>
      </div>
    </div>
  );
}
