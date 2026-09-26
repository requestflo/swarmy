import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Skeleton } from '@swarmy/ui';
import { Link } from '@tanstack/react-router';
import { Section, SectionLink } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { CanaryRunCard } from './canary-run-card';

/**
 * Canary rollout panel on Releases: every in-flight canary with its live
 * traffic split + error rates. Starting one, and the health watch, live on
 * Config › Health & rollout (linked from the heading). Canary state is Docker
 * truth — polled straight off the labels.
 */
export function CanaryPanel({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const canaries = useQuery({
    ...trpc.releases.canaryStatus.queryOptions({ stack }),
    refetchInterval: 5_000,
  });
  const runs = canaries.data ?? [];

  return (
    <Section
      title="Rollout"
      hint={runs.length ? 'a slice of visitors tries it first' : undefined}
      action={
        <Link to="/stacks/$name/config/rollout" params={{ name: stack }} className="pointer-coarse:min-h-11 content-center">
          <SectionLink>Change how changes roll out →</SectionLink>
        </Link>
      }
    >
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
          <p className="text-muted-foreground text-[13.5px]">
            Nothing rolling out. Every change goes out one copy at a time; a canary tries it on a
            slice of visitors first.
          </p>
        ) : (
          runs.map((run) => <CanaryRunCard key={run.canaryService} run={run} />)
        )}
      </div>
    </Section>
  );
}
