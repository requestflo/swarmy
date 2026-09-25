import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Skeleton } from '@swarmy/ui';
import { Section } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { CanaryRunCard } from './canary-run-card';
import { CanaryStartCard } from './canary-start-card';

/**
 * Canary rollout panel for one stack: every in-flight canary with its live
 * traffic split + error rates, and the inline start-canary card when nothing
 * is in flight. Canary state is Docker truth — polled straight off the labels.
 */
export function CanaryPanel({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const canaries = useQuery({
    ...trpc.releases.canaryStatus.queryOptions({ stack }),
    refetchInterval: 5_000,
  });
  const runs = canaries.data ?? [];

  return (
    <Section title="Rollout" hint={runs.length ? 'a slice of visitors tries it first' : undefined}>
      <div className="grid gap-4">
        {canaries.isLoading ? (
          <div className="grid gap-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : canaries.isError ? (
          <div className="grid justify-items-start gap-2">
            <p className="text-tone-bad text-sm">{canaries.error.message}</p>
            <Button size="sm" variant="outline" onClick={() => void canaries.refetch()}>
              Retry
            </Button>
          </div>
        ) : runs.length === 0 ? (
          <>
            <p className="text-muted-foreground text-[13.5px]">
              Nothing rolling out. Try a new version on a slice of visitors first: it takes over
              when clean and goes away on errors.
            </p>
            <CanaryStartCard stack={stack} />
          </>
        ) : (
          runs.map((run) => <CanaryRunCard key={run.canaryService} run={run} />)
        )}
      </div>
    </Section>
  );
}
