import * as React from 'react';
import { cn } from '@swarmy/ui';
import { TextSkeleton } from '@/components/states';
import type { RestartPlan } from './use-restart-plan';

/**
 * "api · 2 copies · one at a time" per service that restarts, then the
 * summary line ("~40 s · no downtime") and an optional note — the plan a
 * rotate or a pasted .env rolls out by.
 */
export function RestartPlanList({
  plan,
  note,
  className,
}: {
  plan: RestartPlan | undefined;
  note?: string;
  className?: string;
}): React.JSX.Element {
  if (!plan) {
    return (
      <div aria-hidden className={cn('flex flex-col gap-1.5', className)}>
        <TextSkeleton className="h-3.5 w-2/3" />
        <TextSkeleton className="h-3.5 w-1/2" />
      </div>
    );
  }
  if (plan.lines.length === 0) {
    return <p className={cn('text-muted-foreground text-[12.5px]', className)}>No service reads it yet, so nothing restarts.</p>;
  }
  return (
    <div className={cn('flex flex-col gap-1.5 text-[12.5px]', className)}>
      <ul className="flex flex-col gap-1">
        {plan.lines.map((l) => (
          <li key={l.name} className="flex items-baseline gap-2">
            <span aria-hidden className={cn('size-2 shrink-0 translate-y-[-1px] rounded-full', l.gap ? 'bg-status-warning' : 'bg-status-progress')} />
            <span className="font-mono">{l.name}</span>
            <span className="text-muted-foreground">{l.words}</span>
          </li>
        ))}
      </ul>
      {plan.summary || note ? (
        <span className="text-muted-foreground font-mono text-[11px]">{[plan.summary, note].filter(Boolean).join(' · ')}</span>
      ) : null}
    </div>
  );
}
