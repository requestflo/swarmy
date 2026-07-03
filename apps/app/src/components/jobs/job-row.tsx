import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { HistoryIcon, PencilIcon, PlayIcon } from 'lucide-react';
import type { ScheduledJobView } from '@swarmy/core';
import {
  Button,
  Collapsible,
  CollapsibleContent,
  Switch,
  toast,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { relTime } from '@/lib/format';
import { DeleteJobConfirm } from './delete-job-confirm';
import { JobEditInline } from './job-edit-inline';
import { JobRunHistoryInline } from './job-run-history-inline';
import { JobRunChip, untilTime } from './job-status';

function IconAction({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={active ? 'secondary' : 'ghost'}
          size="icon"
          aria-label={label}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** One flat job row: what runs, when, how the last run went — expands inline. */
export function JobRow({ stack, job }: { stack: string; job: ScheduledJobView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [mode, setMode] = React.useState<'history' | 'edit' | null>(null);

  const runNow = useMutation(
    trpc.jobs.runNow.mutationOptions({
      onSuccess: () => {
        toast.success(`${job.name} is running`);
        void qc.invalidateQueries();
        setMode('history');
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const toggle = useMutation(
    trpc.jobs.toggle.mutationOptions({
      onSuccess: (j) => {
        toast.success(j.enabled ? `${j.name} resumed` : `${j.name} paused`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Collapsible open={mode !== null} onOpenChange={(open) => !open && setMode(null)}>
      <div className="hover:bg-accent/40 grid grid-cols-2 items-center gap-x-4 gap-y-1 px-4 py-3 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_8rem_9rem_auto]">
        <div className="min-w-0">
          <p className="truncate font-medium">{job.name}</p>
          <p className="mono-data text-muted-foreground truncate text-xs">
            {job.kind === 'image' ? job.image : `exec · ${job.serviceRef}`}
          </p>
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm">{job.scheduleText}</p>
          <p className="mono-data text-muted-foreground text-xs">{job.schedule}</p>
        </div>
        <div className="flex flex-col gap-0.5">
          {job.lastRunStatus ? (
            <JobRunChip status={job.lastRunStatus} />
          ) : (
            <span className="text-muted-foreground text-xs">never ran</span>
          )}
          {job.lastRunAt ? (
            <span className="text-muted-foreground text-xs">{relTime(job.lastRunAt)}</span>
          ) : null}
        </div>
        <div className="text-sm">
          {job.enabled ? (
            <>
              <p>{untilTime(job.nextRunAt)}</p>
              {job.nextRunAt ? (
                <p className="mono-data text-muted-foreground text-xs">
                  {new Date(job.nextRunAt).toLocaleString(undefined, {
                    hour: '2-digit',
                    minute: '2-digit',
                    day: 'numeric',
                    month: 'short',
                  })}
                </p>
              ) : null}
            </>
          ) : (
            <span className="text-muted-foreground text-xs">paused</span>
          )}
        </div>
        <div className="col-span-2 flex items-center justify-end gap-1 sm:col-span-1">
          <Switch
            checked={job.enabled}
            disabled={toggle.isPending}
            onCheckedChange={(enabled) => toggle.mutate({ id: job.id, enabled })}
            aria-label={job.enabled ? 'Pause schedule' : 'Resume schedule'}
          />
          <IconAction label="Run now" onClick={() => runNow.mutate({ id: job.id })}>
            <PlayIcon className="size-4" />
          </IconAction>
          <IconAction
            label="Run history"
            active={mode === 'history'}
            onClick={() => setMode((m) => (m === 'history' ? null : 'history'))}
          >
            <HistoryIcon className="size-4" />
          </IconAction>
          <IconAction
            label="Edit"
            active={mode === 'edit'}
            onClick={() => setMode((m) => (m === 'edit' ? null : 'edit'))}
          >
            <PencilIcon className="size-4" />
          </IconAction>
          <DeleteJobConfirm job={job} />
        </div>
      </div>
      <CollapsibleContent>
        <div className="border-border bg-muted/10 mx-4 mb-3 rounded-lg border p-4">
          {mode === 'history' ? <JobRunHistoryInline jobId={job.id} /> : null}
          {mode === 'edit' ? (
            <JobEditInline stack={stack} job={job} onDone={() => setMode(null)} />
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
