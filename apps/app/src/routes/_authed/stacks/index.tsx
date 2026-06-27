import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { LayersIcon } from 'lucide-react';
import { Card, CardContent, EmptyState } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { DeployStackDialog } from '@/components/stacks/deploy-stack-dialog';
import { StacksList } from '@/components/stacks/stacks-list';

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
    </div>
  );
}
