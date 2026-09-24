import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PlugIcon, PlusIcon, XIcon } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Collapsible,
  CollapsibleContent,
  EmptyState,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { ErrorState, TextSkeleton } from '@/components/states';
import { GitConnectPanel } from './git-connect-panel';
import { GitConnectionRow } from './git-connection-row';

/** The git providers this workspace can pull from — list, connect, disconnect. */
export function GitConnectionsCard(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const list = useQuery(trpc.gitConnections.list.queryOptions());
  const [connectOpen, setConnectOpen] = React.useState(false);

  const onConnected = (): void => {
    setConnectOpen(false);
    void qc.invalidateQueries({ queryKey: trpc.gitConnections.list.queryKey() });
  };

  const toggle = (
    <Button variant="outline" size="sm" onClick={() => setConnectOpen((o) => !o)}>
      {connectOpen ? <XIcon className="size-4" /> : <PlusIcon className="size-4" />}
      {connectOpen ? 'Close' : 'Connect a git provider'}
    </Button>
  );

  return (
    <Card className="card-pop mb-6 overflow-hidden border-0">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="text-base">Connections</CardTitle>
          <CardDescription>
            Where your code lives. Connect once, then pick repos from a list.
          </CardDescription>
        </div>
        {toggle}
      </CardHeader>
      <Collapsible open={connectOpen} onOpenChange={setConnectOpen}>
        <CollapsibleContent>
          <GitConnectPanel onConnected={onConnected} />
        </CollapsibleContent>
      </Collapsible>
      <CardContent className="p-0">
        {list.isPending ? (
          <div className="space-y-3 px-6 pb-6">
            <TextSkeleton className="h-4 w-1/2" />
            <TextSkeleton className="h-4 w-1/3" />
          </div>
        ) : list.isError ? (
          <div className="px-6 pb-6">
            <ErrorState
              error={list.error}
              retry={() => void list.refetch()}
              retrying={list.isFetching}
            />
          </div>
        ) : list.data.length === 0 ? (
          connectOpen ? null : (
            <div className="px-6 pb-6">
              <EmptyState
                icon={<PlugIcon />}
                title="No git provider yet"
                description="Connect GitHub, GitLab or any git host and swarmy builds on every push."
                action={
                  <Button variant="outline" onClick={() => setConnectOpen(true)}>
                    <PlusIcon className="size-4" /> Connect a git provider
                  </Button>
                }
              />
            </div>
          )
        ) : (
          <div className="divide-border divide-y border-t">
            {list.data.map((c) => (
              <GitConnectionRow key={c.id} conn={c} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
