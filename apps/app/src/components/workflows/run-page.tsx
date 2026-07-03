import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeftIcon, OctagonXIcon } from 'lucide-react';
import { Button, Card, CardContent, Skeleton, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { relTime } from '@/lib/format';
import { ApprovalCard } from './approval-card';
import { RunTimeline } from './run-timeline';
import { RunStatusChip, duration } from './workflow-status';

/** One run: live vertical step timeline + approval/cancel controls. */
export function RunPage({ runId }: { runId: string }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const run = useQuery({ ...trpc.workflows.run.queryOptions({ runId }), refetchInterval: 2_000 });

  const cancel = useMutation(
    trpc.workflows.cancel.mutationOptions({
      onSuccess: () => {
        toast.success('Run cancelled');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const r = run.data;
  const active = r?.status === 'running' || r?.status === 'waiting-approval';

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      {r?.stackName ? (
        <Link
          to="/stacks/$name/messaging"
          params={{ name: r.stackName }}
          className="text-muted-foreground mb-4 inline-flex items-center gap-1 text-sm hover:underline"
        >
          <ArrowLeftIcon className="size-4" /> {r.stackName} · Messaging
        </Link>
      ) : (
        <Link
          to="/"
          className="text-muted-foreground mb-4 inline-flex items-center gap-1 text-sm hover:underline"
        >
          <ArrowLeftIcon className="size-4" /> Stacks
        </Link>
      )}
      <PageHeader
        eyebrow="Operations · Workflow run"
        title={
          r ? (
            <>
              {r.defName} <em>v{r.defVersion}</em>.
            </>
          ) : (
            <>
              Workflow <em>run</em>.
            </>
          )
        }
        description={
          r
            ? `Started ${relTime(r.startedAt)} · ${duration(r.durationMs)} · ${Math.min(r.cursor, r.totalSteps)}/${r.totalSteps} steps`
            : undefined
        }
        actions={
          r && active ? (
            <Button
              variant="outline"
              className="text-status-offline border-status-offline/40"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate({ runId })}
            >
              <OctagonXIcon className="size-4" /> {cancel.isPending ? 'Cancelling…' : 'Cancel run'}
            </Button>
          ) : undefined
        }
      />

      {run.isLoading ? (
        <Card className="card-pop border-0">
          <CardContent className="grid gap-3 py-6">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-2/3" />
          </CardContent>
        </Card>
      ) : run.isError ? (
        <Card className="card-pop border-0">
          <CardContent className="flex flex-col items-center gap-3 py-12">
            <p className="text-status-offline text-sm">{run.error.message}</p>
            <Button variant="outline" onClick={() => void run.refetch()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : r ? (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          <Card className="card-pop border-0">
            <CardContent className="py-6">
              <div className="mb-5 flex items-center gap-3">
                <RunStatusChip status={r.status} />
                <span className="mono-data text-muted-foreground text-xs">{r.id}</span>
              </div>
              <RunTimeline steps={r.steps} />
            </CardContent>
          </Card>
          <div className="grid gap-6">
            {r.status === 'waiting-approval' && r.approvalPrompt ? (
              <ApprovalCard runId={r.id} prompt={r.approvalPrompt} />
            ) : null}
            <Card className="card-pop border-0">
              <CardContent className="py-5">
                <p className="mono-label text-muted-foreground !mb-2">Trigger input</p>
                {r.input ? (
                  <pre className="bg-muted/60 mono-data max-h-64 overflow-auto rounded-lg px-3 py-2 text-xs whitespace-pre-wrap">
                    {r.input}
                  </pre>
                ) : (
                  <p className="text-muted-foreground text-sm">Triggered without an input payload.</p>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      ) : null}
    </div>
  );
}
