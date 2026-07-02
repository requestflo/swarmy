import * as React from 'react';
import { Link } from '@tanstack/react-router';
import {
  CheckCircle2Icon,
  ExternalLinkIcon,
  KeyRoundIcon,
  MinusCircleIcon,
  XCircleIcon,
} from 'lucide-react';
import type { BlueprintDeployResultView, BlueprintStepStatus } from '@swarmy/core';
import { Button, CopyButton } from '@swarmy/ui';

function StatusIcon({ status }: { status: BlueprintStepStatus }): React.JSX.Element {
  if (status === 'succeeded') return <CheckCircle2Icon className="text-status-online size-4" />;
  if (status === 'failed') return <XCircleIcon className="text-status-offline size-4" />;
  return <MinusCircleIcon className="text-status-idle size-4" />;
}

/** Step 3 of the wizard: per-step outcomes, one-time reveals and success links. */
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
              {step.detail ? (
                <p className="mono-data text-muted-foreground text-[11px]">{step.detail}</p>
              ) : null}
              {step.error ? (
                <p className="text-status-offline text-xs break-words">{step.error}</p>
              ) : null}
              {step.status === 'skipped' ? (
                <p className="text-muted-foreground text-xs">Skipped after the failure above.</p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>

      {result.notes.length > 0 ? (
        <div className="bg-muted/40 space-y-2 rounded-xl px-3 py-2.5">
          <p className="mono-label flex items-center gap-1.5">
            <KeyRoundIcon className="size-3.5" /> Save these now — shown once
          </p>
          {result.notes.map((note) => (
            <div key={note} className="flex items-center justify-between gap-2">
              <code className="mono-data text-xs break-all">{note}</code>
              <CopyButton value={note} />
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {result.url ? (
          <Button asChild variant="outline" className="rounded-full font-bold">
            <a href={result.url} target="_blank" rel="noreferrer">
              Open {result.url.replace('https://', '')} <ExternalLinkIcon className="size-4" />
            </a>
          </Button>
        ) : null}
        <Button asChild variant="outline" className="rounded-full font-bold">
          <Link to="/stacks">View stack</Link>
        </Button>
        <Button className="rounded-full font-bold" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}
