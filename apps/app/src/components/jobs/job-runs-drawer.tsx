import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { JobRunView, ScheduledJobView } from '@swarmy/core';
import {
  Button,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Skeleton,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { relTime } from '@/lib/format';
import { JobRunChip, runDuration } from './job-status';

function RunRow({ run, onCancel }: { run: JobRunView; onCancel: (id: string) => void }): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <JobRunChip status={run.status} />
        <span className="mono-data text-muted-foreground text-xs">attempt {run.attempt}</span>
        <span className="text-muted-foreground text-xs">{relTime(run.startedAt)}</span>
        <span className="mono-data text-muted-foreground text-xs">
          {runDuration(run.startedAt, run.finishedAt)}
          {run.exitCode != null ? ` · exit ${run.exitCode}` : ''}
        </span>
        <span className="grow" />
        {run.status === 'running' ? (
          <Button variant="ghost" size="sm" onClick={() => onCancel(run.id)}>
            Cancel
          </Button>
        ) : run.outputTail ? (
          <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide output' : 'Output'}
          </Button>
        ) : null}
      </div>
      {open && run.outputTail ? (
        <pre className="bg-muted/40 mono-data mt-2 max-h-64 overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap">
          {run.outputTail}
        </pre>
      ) : null}
    </div>
  );
}

/** Run history drawer: every attempt, its outcome and output tail. */
export function JobRunsDrawer({
  job,
  onOpenChange,
}: {
  job: ScheduledJobView | null;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [limit, setLimit] = React.useState(25);

  const runs = useQuery({
    ...trpc.jobs.runs.queryOptions({ jobId: job?.id ?? '-', limit }),
    enabled: job !== null,
    refetchInterval: 3_000,
  });
  const cancel = useMutation(
    trpc.jobs.cancelRun.mutationOptions({
      onSuccess: () => {
        toast.success('Run cancelled');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Sheet open={job !== null} onOpenChange={(v) => { setLimit(25); onOpenChange(v); }}>
      <SheetContent side="right" className="sm:max-w-xl">
        <SheetHeader className="pb-0">
          <SheetTitle>{job?.name}</SheetTitle>
          <SheetDescription>
            {job?.scheduleText} · <span className="mono-data">{job?.schedule}</span>
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {runs.isLoading ? (
            <div className="grid gap-3 p-4">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-2/3" />
            </div>
          ) : runs.isError ? (
            <div className="flex flex-col items-center gap-3 p-8">
              <p className="text-status-offline text-sm">{runs.error.message}</p>
              <Button variant="outline" onClick={() => void runs.refetch()}>
                Retry
              </Button>
            </div>
          ) : (runs.data?.runs.length ?? 0) === 0 ? (
            <p className="text-muted-foreground p-8 text-center text-sm">
              No runs yet — hit “Run now” on the job to try it.
            </p>
          ) : (
            <div className="divide-border divide-y">
              {runs.data?.runs.map((run) => (
                <RunRow key={run.id} run={run} onCancel={(runId) => cancel.mutate({ runId })} />
              ))}
              {runs.data?.nextCursor ? (
                <div className="p-3 text-center">
                  <Button variant="ghost" size="sm" onClick={() => setLimit((l) => l + 25)}>
                    Show older runs
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
