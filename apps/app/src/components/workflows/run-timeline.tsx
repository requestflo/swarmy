import * as React from 'react';
import type { WorkflowStepRunView } from '@swarmy/core';
import { StatusBadge, cn } from '@swarmy/ui';
import { STEP_KIND_LABEL, STEP_STATUS_META, duration } from './workflow-status';

const DOT: Record<string, string> = {
  pending: 'bg-status-idle/30',
  running: 'bg-status-progress animate-pulse',
  waiting: 'bg-status-warning animate-pulse',
  succeeded: 'bg-status-online',
  failed: 'bg-status-offline',
  cancelled: 'bg-status-idle',
};

function stepDuration(step: WorkflowStepRunView): string | null {
  if (!step.startedAt) return null;
  const end = step.finishedAt ? new Date(step.finishedAt).getTime() : Date.now();
  return duration(end - new Date(step.startedAt).getTime());
}

/** Vertical step timeline: status dot rail, per-step output and errors. */
export function RunTimeline({ steps }: { steps: WorkflowStepRunView[] }): React.JSX.Element {
  return (
    <ol className="grid">
      {steps.map((step, i) => {
        const meta = STEP_STATUS_META[step.status];
        return (
          <li key={step.index} className="grid grid-cols-[1.5rem_1fr] gap-x-3">
            <div className="flex flex-col items-center">
              <span className={cn('mt-1.5 size-3 shrink-0 rounded-full', DOT[step.status])} />
              {i < steps.length - 1 ? <span className="bg-border w-px flex-1" /> : null}
            </div>
            <div className={cn('min-w-0 pb-5', step.status === 'pending' && 'opacity-60')}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="mono-data text-sm font-semibold">
                  {step.index + 1}. {step.name}
                </span>
                <span className="text-muted-foreground text-xs">{STEP_KIND_LABEL[step.kind]}</span>
                <StatusBadge tone={meta.tone} label={meta.label} />
                {stepDuration(step) ? (
                  <span className="mono-data text-muted-foreground text-xs">{stepDuration(step)}</span>
                ) : null}
              </div>
              {step.error ? (
                <pre className="bg-status-offline/10 text-status-offline mt-2 max-h-48 overflow-auto rounded-lg px-3 py-2 text-xs whitespace-pre-wrap">
                  {step.error}
                </pre>
              ) : null}
              {step.output ? (
                <pre className="bg-muted/60 mono-data mt-2 max-h-48 overflow-auto rounded-lg px-3 py-2 text-xs whitespace-pre-wrap">
                  {step.output}
                </pre>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
