import * as React from 'react';
import { CheckCircle2Icon, MinusCircleIcon, XCircleIcon } from 'lucide-react';
import type { BlueprintDeployResultView, BlueprintStepStatus } from '@swarmy/core';
import { Button } from '@swarmy/ui';
import { DeploySecretsBanner } from '@/components/deploy/deploy-secrets-banner';

function StatusIcon({ status }: { status: BlueprintStepStatus }): React.JSX.Element {
  if (status === 'succeeded') return <CheckCircle2Icon className="text-tone-ok size-4" />;
  if (status === 'failed') return <XCircleIcon className="text-tone-bad size-4" />;
  return <MinusCircleIcon className="text-tone-idle size-4" />;
}

/**
 * A run that stopped before the app itself went out (so there is no app page
 * to watch): per-step outcomes and any one-time reveals from the steps that
 * did run. Every run that got the app out lands on the app page instead
 * (components/deploy/deploy-flow).
 */
export function BlueprintDeployResult({
  result,
  onClose,
}: {
  result: BlueprintDeployResultView;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <div className="space-y-4">
      <ol className="divide-border divide-y rounded-xl border">
        {result.steps.map((step, i) => (
          <li key={`${step.kind}-${i}`} className="flex items-start gap-3 px-3 py-2.5">
            <span className="pt-0.5">
              <StatusIcon status={step.status} />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium">{step.label}</p>
              {step.detail ? <p className="mono-data text-muted-foreground text-[11px]">{step.detail}</p> : null}
              {step.error ? <p className="text-tone-bad text-xs break-words">{step.error}</p> : null}
              {step.status === 'skipped' ? <p className="text-muted-foreground text-xs">Skipped after the failure above.</p> : null}
            </div>
          </li>
        ))}
      </ol>
      <DeploySecretsBanner notes={result.notes} />
      <div className="flex justify-end">
        <Button variant="outline" className="rounded-full font-bold" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}
