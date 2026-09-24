import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpCircleIcon } from 'lucide-react';
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
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

const STEP_LABEL: Record<string, string> = {
  preflight: 'Checking the store',
  stop: 'Stopping storage',
  backup: 'Copying metadata',
  deploy: 'Starting the new version',
  verify: 'Verifying data',
  rollback: 'Rolling back',
  done: 'Done',
};

/**
 * Object-storage engine upgrade (Garage major). Hidden when the store is
 * current and no run is recent; shows the impact before confirming and live
 * progress while it runs.
 */
export function EngineUpgradeCard(): React.JSX.Element | null {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const q = useQuery({
    ...trpc.storage.engineUpgrade.queryOptions(),
    refetchInterval: (query) => (query.state.data?.run?.status === 'running' ? 3_000 : 60_000),
  });
  const start = useMutation(
    trpc.storage.startEngineUpgrade.mutationOptions({
      onSuccess: () => {
        toast.success('Storage upgrade started');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const v = q.data;
  if (!v) return null;
  const run = v.run;
  const running = run?.status === 'running';
  const recent = run && run.finishedAt && Date.now() - new Date(run.finishedAt).getTime() < 24 * 3600_000;
  if (!v.available && !running && !recent) return null;

  const tag = (img: string) => img.split(':').pop();

  return (
    <div className="card-pop mb-6 space-y-3 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <ArrowUpCircleIcon className="size-4" />
            {running
              ? `Upgrading storage to ${tag(run.to)} — ${STEP_LABEL[run.step] ?? run.step}…`
              : run?.status === 'done' && !v.available
                ? `Storage upgraded to ${tag(run.to)}`
                : run?.status === 'rolled-back'
                  ? `Storage upgrade rolled back — still on ${tag(v.running)}`
                  : run?.status === 'failed'
                    ? 'Storage upgrade failed'
                    : `Storage engine update: ${tag(v.running)} → ${tag(v.available ?? '')}`}
          </p>
          <p className="text-muted-foreground mt-1 max-w-3xl text-xs">
            {run?.error && !running ? run.error : v.impact}
          </p>
        </div>
        {v.available && !running ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button disabled={start.isPending}>Upgrade storage</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Upgrade object storage to {tag(v.available)}?</AlertDialogTitle>
                <AlertDialogDescription>{v.impact}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Not now</AlertDialogCancel>
                <AlertDialogAction onClick={() => start.mutate()}>Upgrade now</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </div>
      {run && (running || recent) ? (
        <ol className="text-muted-foreground mono-data max-h-40 space-y-0.5 overflow-y-auto text-xs">
          {run.log.slice(-8).map((l) => (
            <li key={l.at + l.msg}>
              {new Date(l.at).toLocaleTimeString()} — {l.msg}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
