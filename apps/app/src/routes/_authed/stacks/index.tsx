import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { LayersIcon } from 'lucide-react';
import { Card, CardContent, EmptyState } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { DeployStackDialog } from '@/components/stacks/deploy-stack-dialog';
import { StacksList } from '@/components/stacks/stacks-list';
import { ManagedDbPanel } from '@/components/stacks/managed-db-panel';

export const Route = createFileRoute('/_authed/stacks/')({
  component: StacksPage,
});

function StacksPage(): React.JSX.Element {
  const trpc = useTRPC();
  const stacks = useQuery({ ...trpc.stacks.list.queryOptions(), refetchInterval: 4_000 });

  const list = stacks.data ?? [];
  const total = list.length;
  const running = list.filter((s) => s.status === 'running').length;
  const allRunning = total > 0 && running === total;
  const isEmpty = stacks.data !== undefined && total === 0;

  const [dbStack, setDbStack] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!dbStack && list.length) setDbStack(list[0]?.name ?? null);
  }, [dbStack, list]);

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Stacks"
        title={
          total === 0 ? (
            <>
              Ship a whole app at <em>once</em>.
            </>
          ) : allRunning ? (
            <>
              All <em>{running}</em> stacks running.
            </>
          ) : (
            <>
              <em>{running}</em> of {total} stacks running.
            </>
          )
        }
        description="Deploy multi-service apps straight from a compose file."
        actions={<DeployStackDialog />}
      />
      {isEmpty ? (
        <Card className="card-pop border-0">
          <CardContent className="p-0">
            <EmptyState
              icon={<LayersIcon />}
              title="Nothing shipped yet."
              description="Paste a compose file and deploy every service in one move — they show up here as they converge."
              action={<DeployStackDialog />}
            />
          </CardContent>
        </Card>
      ) : (
        <StacksList stacks={list} />
      )}

      {dbStack && list.length > 0 && (
        <div className="mt-10 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">Databases for</span>
            <select
              value={dbStack}
              onChange={(e) => setDbStack(e.target.value)}
              className="bg-card border-border rounded-md border px-2 py-1 text-sm"
            >
              {list.map((s) => (
                <option key={s.id} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <ManagedDbPanel stack={dbStack} />
        </div>
      )}
    </div>
  );
}
