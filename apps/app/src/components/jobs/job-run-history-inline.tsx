import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { JobRunView } from '@swarmy/core';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { relTime } from '@/lib/format';
import { JobRunChip, runDuration } from './job-status';

function RunRow({ run, onCancel }: { run: JobRunView; onCancel: (id: string) => void }): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="py-2.5">
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

/** Run history, inline: every attempt, its outcome and output tail. */
export function JobRunHistoryInline({ jobId }: { jobId: string }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [limit, setLimit] = React.useState(25);

  const runs = useQuery({
    ...trpc.jobs.runs.queryOptions({ jobId, limit }),
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

  if (runs.isLoading) {
    return (
      <div className="space-y-2">
        <div className="shimmer-line h-8 rounded-lg" />
        <div className="shimmer-line h-8 rounded-lg" />
      </div>
    );
  }
  if (runs.isError) {
    return (
      <div className="flex items-center gap-3">
        <p className="text-status-offline text-sm">{runs.error.message}</p>
        <Button variant="outline" size="sm" onClick={() => void runs.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  if ((runs.data?.runs.length ?? 0) === 0) {
    return (
      <p className="text-muted-foreground text-sm">No runs yet — hit “Run now” on the job to try it.</p>
    );
  }

  return (
    <div className="divide-border divide-y">
      {runs.data?.runs.map((run) => (
        <RunRow key={run.id} run={run} onCancel={(runId) => cancel.mutate({ runId })} />
      ))}
      {runs.data?.nextCursor ? (
        <div className="pt-2 text-center">
          <Button variant="ghost" size="sm" onClick={() => setLimit((l) => l + 25)}>
            Show older runs
          </Button>
        </div>
      ) : null}
    </div>
  );
}
