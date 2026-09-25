import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FastForwardIcon, RotateCcwIcon, Trash2Icon } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  CopyButton,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CardSkeleton } from '@/components/states';
import { attempts, msTime, pretty, type StudioRef } from './studio-types';

/** One job in full: payload, options, progress, attempts, stacktrace, logs, and its actions. */
export function JobDetail({
  studio,
  queue,
  id,
  onGone,
}: {
  studio: StudioRef;
  queue: string;
  id: string;
  onGone: () => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const ref = { ...studio, queue, id };
  const job = useQuery({ ...trpc.queues.studioJob.queryOptions(ref), retry: false });
  const done = (msg: string, gone = false): void => {
    toast.success(msg);
    void qc.invalidateQueries();
    if (gone) onGone();
  };
  const onError = (e: { message: string }) => toast.error(e.message);
  const retry = useMutation(trpc.queues.studioRetry.mutationOptions({ onSuccess: (r) => done(r.message, true), onError }));
  const promote = useMutation(trpc.queues.studioPromote.mutationOptions({ onSuccess: (r) => done(r.message, true), onError }));
  const remove = useMutation(trpc.queues.studioRemove.mutationOptions({ onSuccess: (r) => done(r.message, true), onError }));

  if (job.isLoading) return <CardSkeleton lines={4} className="mb-2" />;
  if (job.isError) return <p className="text-tone-bad mb-2 text-sm">{job.error.message}</p>;
  const d = job.data!;
  if (!d.found) return <p className="text-muted-foreground mb-2 text-sm">This job is gone.</p>;
  const j = d.job;
  const trace = (() => {
    try {
      const arr = JSON.parse(j.stacktrace ?? '[]') as string[];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return j.stacktrace ? [j.stacktrace] : [];
    }
  })();

  return (
    <div className="border-border bg-muted/10 mb-2 space-y-4 rounded-lg border p-4">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
        {(
          [
            ['State', d.state],
            ['Attempts', String(attempts(j))],
            ['Added', msTime(j.timestamp)],
            ['Finished', msTime(j.finishedOn)],
            ['Started', msTime(j.processedOn)],
            ['Progress', j.progress ?? '—'],
            ['Priority', j.priority ?? '0'],
            ['Worker', j.processedBy ?? '—'],
          ] as const
        ).map(([k, v]) => (
          <div key={k}>
            <dt className="mono-label text-muted-foreground !mb-0 !text-[10px]">{k}</dt>
            <dd className="mono-data truncate">{v}</dd>
          </div>
        ))}
      </dl>

      {j.failedReason ? (
        <div>
          <p className="mono-label text-tone-bad !mb-1">Failed reason</p>
          <p className="text-sm">{j.failedReason}</p>
        </div>
      ) : null}

      <Block title="Payload" body={pretty(j.data)} truncated={j.dataTruncated} />
      {trace.length > 0 ? (
        <Block title="Stacktrace" body={trace.join('\n\n')} truncated={j.stacktraceTruncated} />
      ) : null}
      {j.returnvalue && j.returnvalue !== 'null' ? (
        <Block title="Return value" body={pretty(j.returnvalue)} truncated={j.returnvalueTruncated} />
      ) : null}
      {d.logs.length > 0 ? (
        <Block
          title={`Logs${d.logCount > d.logs.length ? ` (last ${d.logs.length} of ${d.logCount})` : ''}`}
          body={d.logs.join('\n')}
        />
      ) : null}
      <Block title="Options" body={pretty(j.opts)} />

      <div className="flex flex-wrap gap-2">
        {d.state === 'failed' || d.state === 'completed' ? (
          <Button
            size="sm"
            variant="outline"
            disabled={retry.isPending}
            onClick={() => retry.mutate({ ...ref, from: d.state === 'completed' ? 'completed' : 'failed' })}
          >
            <RotateCcwIcon className="size-3.5" /> Retry
          </Button>
        ) : null}
        {d.state === 'delayed' ? (
          <Button size="sm" variant="outline" disabled={promote.isPending} onClick={() => promote.mutate(ref)}>
            <FastForwardIcon className="size-3.5" /> Run now
          </Button>
        ) : null}
        {d.state !== 'active' ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="text-tone-bad border-status-offline/40 hover:bg-status-offline/10"
                disabled={remove.isPending}
              >
                <Trash2Icon className="size-3.5" /> Remove
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Remove job #{id}?</AlertDialogTitle>
                <AlertDialogDescription>
                  Deletes the job, its data, logs and any child jobs. This can’t be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => remove.mutate(ref)}>Remove</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : (
          <p className="text-muted-foreground text-[11px]">A worker holds this job — it can’t be removed while active.</p>
        )}
      </div>
    </div>
  );
}

function Block({ title, body, truncated }: { title: string; body: string; truncated?: boolean }): React.JSX.Element {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="mono-label text-muted-foreground !mb-0">
          {title}
          {truncated ? ' · truncated at 64 KB' : ''}
        </p>
        <CopyButton value={body} />
      </div>
      <pre className="bg-muted/40 mono-data max-h-72 overflow-auto rounded-md p-3 text-[11px] leading-relaxed whitespace-pre-wrap break-all">
        {body || '—'}
      </pre>
    </div>
  );
}
