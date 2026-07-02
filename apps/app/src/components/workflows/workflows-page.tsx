import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon, WorkflowIcon } from 'lucide-react';
import type { WorkflowDefView } from '@swarmy/core';
import { Button, Card, CardContent, EmptyState, Skeleton } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { BuilderDialog } from './builder-dialog';
import { DefsList } from './defs-list';
import { RunsTable } from './runs-table';

/** The Workflows surface: definitions + live runs, one builder dialog. */
export function WorkflowsPage(): React.JSX.Element {
  const trpc = useTRPC();
  const [builderOpen, setBuilderOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<WorkflowDefView | null>(null);

  const overview = useQuery({ ...trpc.workflows.overview.queryOptions(), refetchInterval: 5_000 });
  const defs = useQuery({ ...trpc.workflows.defs.queryOptions(), refetchInterval: 5_000 });
  const runs = useQuery({ ...trpc.workflows.runs.queryOptions({ limit: 50 }), refetchInterval: 3_000 });

  const o = overview.data;
  const hero = !o ? (
    <>
      <em>Workflows</em>.
    </>
  ) : o.waitingApproval > 0 ? (
    <>
      {o.waitingApproval} run{o.waitingApproval === 1 ? '' : 's'} need <em>you</em>.
    </>
  ) : o.running > 0 ? (
    <>
      {o.running} run{o.running === 1 ? '' : 's'} <em>in flight</em>.
    </>
  ) : o.failed24h > 0 ? (
    <>
      {o.failed24h} run{o.failed24h === 1 ? '' : 's'} <em>failed</em> today.
    </>
  ) : o.defs > 0 ? (
    <>
      {o.defs} workflow{o.defs === 1 ? '' : 's'}, all <em>quiet</em>.
    </>
  ) : (
    <>
      Automate the <em>boring</em> bits.
    </>
  );

  const openCreate = (): void => {
    setEditing(null);
    setBuilderOpen(true);
  };

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Operations · Workflows"
        title={hero}
        description="Multi-step automations — containers, execs, webhooks, approvals and delays — versioned and replayable."
        actions={
          <Button onClick={openCreate}>
            <PlusIcon className="size-4" /> New workflow
          </Button>
        }
      />

      {defs.isLoading || runs.isLoading ? (
        <Card className="card-pop border-0">
          <CardContent className="grid gap-3 py-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-2/3" />
          </CardContent>
        </Card>
      ) : defs.isError || runs.isError ? (
        <Card className="card-pop border-0">
          <CardContent className="flex flex-col items-center gap-3 py-12">
            <p className="text-status-offline text-sm">{defs.error?.message ?? runs.error?.message}</p>
            <Button variant="outline" onClick={() => void Promise.all([defs.refetch(), runs.refetch()])}>
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : (defs.data ?? []).length === 0 ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<WorkflowIcon />}
            title="No workflows yet"
            description="Define a workflow — steps, approvals, delays — then trigger it manually, on schedule or from a webhook."
            action={
              <Button onClick={openCreate}>
                <PlusIcon className="size-4" /> New workflow
              </Button>
            }
          />
        </div>
      ) : (
        <div className="grid gap-6">
          <section>
            <h2 className="mono-label text-muted-foreground mb-2">Definitions</h2>
            <div className="card-pop overflow-hidden">
              <DefsList
                defs={defs.data ?? []}
                onEdit={(def) => {
                  setEditing(def);
                  setBuilderOpen(true);
                }}
              />
            </div>
          </section>
          <section>
            <h2 className="mono-label text-muted-foreground mb-2">Runs</h2>
            <div className="card-pop overflow-hidden">
              {(runs.data?.runs ?? []).length === 0 ? (
                <p className="text-muted-foreground px-5 py-8 text-center text-sm">
                  No runs yet — hit Run on a workflow above.
                </p>
              ) : (
                <RunsTable runs={runs.data?.runs ?? []} />
              )}
            </div>
          </section>
        </div>
      )}

      <BuilderDialog editing={editing} open={builderOpen} onOpenChange={setBuilderOpen} />
    </div>
  );
}
