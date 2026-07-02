import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { HeartPulseIcon } from 'lucide-react';
import { Button, EmptyState } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { DrillCards } from './drill-cards';
import { DrillHistory } from './drill-history';
import { ProblemsList } from './problems-list';
import { ScoreRing } from './score-ring';

/**
 * Protection → Resilience: the readiness score ring, the problems feed with
 * fix links, and the safe drills (restore / failover / backup-verify).
 */
export function ResiliencePage(): React.JSX.Element {
  const trpc = useTRPC();
  const overview = useQuery({
    ...trpc.resilience.overview.queryOptions(),
    refetchInterval: 15_000,
  });
  const history = useQuery({
    ...trpc.resilience.drillHistory.queryOptions({ limit: 20 }),
    refetchInterval: 30_000,
  });

  const score = overview.data?.score;
  const title = !score ? (
    <>
      How ready is <em>ready</em>?
    </>
  ) : score.problems.length === 0 ? (
    <>
      You'd survive. <em>{score.score}%</em> ready.
    </>
  ) : (
    <>
      <em>{score.score}%</em> ready — {score.problems.length} fix
      {score.problems.length === 1 ? '' : 'es'} to go.
    </>
  );

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Protection · Resilience"
        title={title}
        description="One score for how well you'd survive failure — what's weakening it, how to fix it, and safe drills that prove your recovery story."
      />

      {overview.isLoading ? (
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <div className="card-pop space-y-3 p-5">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="shimmer-line h-14 rounded-lg" />
            ))}
          </div>
          <div className="card-pop shimmer-line h-72" />
        </div>
      ) : overview.isError ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<HeartPulseIcon />}
            title="Couldn't score the estate"
            description={overview.error.message}
            action={
              <Button variant="outline" onClick={() => void overview.refetch()}>
                Retry
              </Button>
            }
          />
        </div>
      ) : overview.data ? (
        <div className="space-y-8">
          <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
            <div className="min-w-0">
              <ProblemsList problems={overview.data.score.problems} />
            </div>
            <ScoreRing score={overview.data.score} />
          </div>
          <DrillCards drills={overview.data.drills} targets={overview.data.drillTargets} />
          <DrillHistory history={history.data ?? []} isLoading={history.isLoading} />
        </div>
      ) : null}
    </div>
  );
}
