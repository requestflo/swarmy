import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon, WorkflowIcon } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  EmptyState,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { DefRow } from './def-row';
import { RunsTable } from './runs-table';
import { WorkflowBuilderInline } from './workflow-builder-inline';

/**
 * Workflows section of the stack Messaging tab: this stack's workflow defs
 * as flat rows (row-expand for the builder / new version), an inline create
 * form, and recent runs (linking out to the run timeline sub-page).
 */
export function StackWorkflowsSection({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const [creating, setCreating] = React.useState(false);

  const overview = useQuery({
    ...trpc.workflows.overview.queryOptions({ stack }),
    refetchInterval: 5_000,
  });
  const defs = useQuery({
    ...trpc.workflows.defs.queryOptions({ stack }),
    refetchInterval: 5_000,
  });
  const runs = useQuery({
    ...trpc.workflows.runs.queryOptions({ limit: 25, stack }),
    refetchInterval: 3_000,
  });

  const rows = defs.data ?? [];
  const o = overview.data;
  const subtitle = !o
    ? 'containers, execs, webhooks, approvals & delays'
    : o.waitingApproval > 0
      ? `${o.waitingApproval} need${o.waitingApproval === 1 ? 's' : ''} you`
      : o.running > 0
        ? `${o.running} in flight`
        : o.failed24h > 0
          ? `${o.failed24h} failed today`
          : 'containers, execs, webhooks, approvals & delays';

  return (
    <Card className="card-pop border-0">
      <CardContent className="space-y-4 p-6">
        <Collapsible open={creating} onOpenChange={setCreating}>
          <div className="flex flex-wrap items-center gap-3">
            <span className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
              <WorkflowIcon className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="font-semibold leading-tight">Workflows</h3>
              <p className="text-muted-foreground mono-label !mb-0">{subtitle}</p>
            </div>
            <CollapsibleTrigger asChild>
              <Button variant="outline" className="shrink-0">
                <PlusIcon className="size-4" /> New workflow
              </Button>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent>
            <div className="border-border bg-muted/20 mt-4 rounded-lg border p-4">
              <WorkflowBuilderInline stack={stack} editing={null} onDone={() => setCreating(false)} />
            </div>
          </CollapsibleContent>
        </Collapsible>

        {defs.isLoading ? (
          <div className="space-y-2">
            <div className="shimmer-line h-12 rounded-lg" />
            <div className="shimmer-line h-12 rounded-lg" />
          </div>
        ) : defs.isError ? (
          <div className="flex flex-wrap items-center gap-3 py-2">
            <p className="text-status-offline text-sm">{defs.error.message}</p>
            <Button variant="outline" size="sm" onClick={() => void defs.refetch()}>
              Retry
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<WorkflowIcon />}
            title={`No workflows in ${stack} yet.`}
            description="Define a workflow — steps, approvals, delays — then trigger it manually, on schedule or from a webhook."
            action={
              <Button variant="outline" onClick={() => setCreating(true)}>
                <PlusIcon className="size-4" /> New workflow
              </Button>
            }
          />
        ) : (
          <div className="divide-border divide-y">
            {rows.map((def) => (
              <DefRow key={def.name} stack={stack} def={def} />
            ))}
          </div>
        )}

        {rows.length > 0 ? (
          <section className="space-y-2 pt-2">
            <h4 className="mono-label text-muted-foreground">Recent runs</h4>
            {(runs.data?.runs ?? []).length === 0 ? (
              <p className="text-muted-foreground text-sm">No runs yet — hit Run on a workflow above.</p>
            ) : (
              <div className="border-border overflow-hidden rounded-lg border">
                <RunsTable runs={runs.data?.runs ?? []} />
              </div>
            )}
          </section>
        ) : null}
      </CardContent>
    </Card>
  );
}
