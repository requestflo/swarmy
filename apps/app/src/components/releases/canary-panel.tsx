import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, CardContent, CardHeader, CardTitle, Skeleton } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CanaryRunCard } from './canary-run-card';
import { CanaryStartDialog } from './canary-start-dialog';

/**
 * Canary rollout panel (slice D2). Shows every in-flight canary for the
 * selected stack (or the whole org when none is selected) with live traffic
 * split + error rates, and the start dialog when a stack is in focus.
 * Canary state is Docker truth — polled straight off the labels.
 */
export function CanaryPanel({ stackName }: { stackName: string | null }): React.JSX.Element {
  const trpc = useTRPC();
  const canaries = useQuery({
    ...trpc.releases.canaryStatus.queryOptions({ stack: stackName ?? undefined }),
    refetchInterval: 5_000,
  });
  const runs = canaries.data ?? [];

  return (
    <Card className="card-pop border-0">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
        <CardTitle className="text-base">
          Canary rollout{stackName ? ` · ${stackName}` : ''}
        </CardTitle>
        {stackName && runs.length === 0 && !canaries.isLoading ? (
          <CanaryStartDialog stackName={stackName} />
        ) : null}
      </CardHeader>
      <CardContent className="grid gap-4">
        {canaries.isLoading ? (
          <div className="grid gap-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : canaries.isError ? (
          <div className="grid justify-items-start gap-2">
            <p className="text-status-offline text-sm">{canaries.error.message}</p>
            <Button size="sm" variant="outline" onClick={() => void canaries.refetch()}>
              Retry
            </Button>
          </div>
        ) : runs.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {stackName
              ? 'No canary in flight. Try a new image on a slice of real traffic — it promotes itself when clean and rolls back on errors.'
              : 'No canaries in flight anywhere. Pick a stack to start one.'}
          </p>
        ) : (
          runs.map((run) => <CanaryRunCard key={run.canaryService} run={run} />)
        )}
      </CardContent>
    </Card>
  );
}
