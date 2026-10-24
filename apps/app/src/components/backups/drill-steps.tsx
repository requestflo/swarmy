import * as React from 'react';
import { CheckIcon, LoaderCircleIcon, MinusIcon, XIcon } from 'lucide-react';
import type { ResilienceDrillStepView } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { formatDurationMs } from '@/components/resilience/format';
import { stepWords } from './drill-words';

const ICON = { passed: CheckIcon, failed: XIcon, skipped: MinusIcon } as const;

interface DrillStepsProps {
  steps: ResilienceDrillStepView[];
  dim?: boolean;
  /** A run in flight: the step running now (`resilience.drillProgress`). */
  current?: { name: string } | null;
}

/** The steps of one drill run: what it did, how long each took, and what it is doing now. */
export function DrillSteps({ steps, dim, current }: DrillStepsProps): React.JSX.Element {
  return (
    <ol aria-label="Drill steps" className={cn('flex flex-col gap-1.5', dim && 'opacity-60')}>
      {steps.map((s, i) => {
        const Icon = ICON[s.status];
        return (
          <li key={`${i}-${s.name}`} className="flex items-start gap-2.5 text-[13px]">
            <span
              aria-hidden
              className={cn(
                'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full',
                s.status === 'passed' && 'bg-status-online text-background',
                s.status === 'failed' && 'bg-status-offline text-background',
                s.status === 'skipped' && 'border-border border',
              )}
            >
              <Icon className="size-2.5" strokeWidth={3.5} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span>{stepWords(s.name)}</span>
              <Tech>{s.name}{s.detail ? ` · ${s.detail}` : ''}</Tech>
            </span>
            <span className="text-muted-foreground shrink-0 font-mono text-[11.5px]">
              {s.durationMs != null ? formatDurationMs(s.durationMs) : ''}
            </span>
          </li>
        );
      })}
      {current ? (
        <li aria-current="step" className="flex items-start gap-2.5 text-[13px]">
          <span aria-hidden className="text-tone-info mt-0.5 flex size-4 shrink-0 items-center justify-center">
            <LoaderCircleIcon className="size-3.5 animate-spin motion-reduce:animate-none" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="font-semibold">{stepWords(current.name)}</span>
            <Tech>{current.name} · running now</Tech>
          </span>
        </li>
      ) : null}
    </ol>
  );
}
