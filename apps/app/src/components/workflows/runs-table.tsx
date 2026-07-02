import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ChevronRightIcon } from 'lucide-react';
import type { WorkflowRunView } from '@swarmy/core';
import { relTime } from '@/lib/format';
import { RunStatusChip, duration } from './workflow-status';

/** Runs, newest first — each row links to the run's step timeline. */
export function RunsTable({ runs }: { runs: WorkflowRunView[] }): React.JSX.Element {
  return (
    <div>
      <div className="text-muted-foreground mono-label hidden grid-cols-[1.4fr_8rem_1fr_6rem_6rem_1.5rem] items-center gap-3 border-b px-5 py-2.5 !text-[10px] lg:grid">
        <span>Workflow</span>
        <span>Status</span>
        <span>Step</span>
        <span className="text-right">Started</span>
        <span className="text-right">Duration</span>
        <span />
      </div>
      <div className="divide-border divide-y">
        {runs.map((run) => (
          <Link
            key={run.id}
            to="/workflows/$runId"
            params={{ runId: run.id }}
            className="hover:bg-accent/50 grid grid-cols-[1fr_auto] items-center gap-3 px-5 py-3.5 transition-colors lg:grid-cols-[1.4fr_8rem_1fr_6rem_6rem_1.5rem]"
          >
            <span className="min-w-0">
              <span className="mono-data block truncate text-sm font-semibold">{run.defName}</span>
              <span className="text-muted-foreground block truncate text-xs">
                v{run.defVersion} · {run.id.slice(0, 10)}
              </span>
            </span>
            <span className="hidden lg:block">
              <RunStatusChip status={run.status} />
            </span>
            <span className="hidden min-w-0 lg:block">
              <span className="block truncate text-xs">
                {run.status === 'succeeded' ? 'done' : (run.currentStep ?? '—')}
              </span>
              <span className="mono-label text-muted-foreground !mb-0 !text-[10px]">
                {Math.min(run.cursor, run.totalSteps)}/{run.totalSteps} steps
              </span>
            </span>
            <span className="text-muted-foreground hidden text-right text-xs lg:block">{relTime(run.startedAt)}</span>
            <span className="mono-data hidden text-right text-sm lg:block">{duration(run.durationMs)}</span>
            <span className="flex items-center justify-end gap-3 lg:hidden">
              <RunStatusChip status={run.status} />
            </span>
            <ChevronRightIcon className="text-muted-foreground hidden size-4 justify-self-end lg:block" />
          </Link>
        ))}
      </div>
    </div>
  );
}
