import * as React from 'react';
import type { BlueprintPlanStepView } from '@swarmy/core';

/** A plain one-line detail per step kind (the mono kind carries the jargon). */
export function stepDetail(step: BlueprintPlanStepView): string {
  const d = step.detail;
  switch (step.kind) {
    case 'db.provision':
      return `Postgres · ${d.replicas ?? 'no read replicas'}`;
    case 'cache.provision':
      return [d.engine, d.memory, d.topology].filter(Boolean).join(' · ');
    case 'bucket':
      return d.bucket ?? 'a bucket';
    case 'secret':
      return `${d.family ?? 'secret'} · generated, write-only`;
    case 'stack.deploy':
      return d.services ?? step.label;
    case 'ingress.route':
      return `${d.host} → ${d.service}:${d.port}`;
    default:
      return step.label;
  }
}

/** The dry-run, numbered: mono step kind + plain detail. */
export function PlanSteps({ steps }: { steps: BlueprintPlanStepView[] }): React.JSX.Element {
  return (
    <ol className="flex flex-col gap-1.5">
      {steps.map((s, i) => (
        <li key={`${s.kind}-${i}`} className="grid grid-cols-[1.25rem_7.5rem_minmax(0,1fr)] items-baseline gap-2 text-[12px]">
          <span className="text-muted-foreground font-mono">{i + 1}</span>
          <span className="text-tone-info font-mono">{s.kind}</span>
          <span className="text-muted-foreground font-mono break-words">{stepDetail(s)}</span>
        </li>
      ))}
    </ol>
  );
}
