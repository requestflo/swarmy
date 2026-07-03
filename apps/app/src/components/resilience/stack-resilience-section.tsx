import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { HeartPulseIcon } from 'lucide-react';
import { Button, EmptyState } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { DrillCards } from './drill-cards';
import { DrillHistory } from './drill-history';
import { ProblemsList } from './problems-list';
import { ScoreRing } from './score-ring';

interface StackResilienceSectionProps {
  stack: string;
}

/**
 * This stack's slice of the resilience picture: readiness score, what's
 * weakening it, and the safe drills scoped to this stack's clusters.
 */
export function StackResilienceSection({ stack }: StackResilienceSectionProps): React.JSX.Element {
  const trpc = useTRPC();
  const overview = useQuery({
    ...trpc.resilience.overview.queryOptions({ stack }),
    refetchInterval: 15_000,
  });
  const history = useQuery({
    ...trpc.resilience.drillHistory.queryOptions({ limit: 10, stack }),
    refetchInterval: 30_000,
  });

  return (
    <section>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <span className="mono-label">Resilience</span>
          <p className="text-muted-foreground mt-0.5 text-xs">
            One score for how well {stack} would survive failure.
          </p>
        </div>
      </div>

      {overview.isLoading ? (
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <div className="card-pop space-y-3 p-5">
            {[0, 1].map((i) => (
              <div key={i} className="shimmer-line h-14 rounded-lg" />
            ))}
          </div>
          <div className="card-pop shimmer-line h-72" />
        </div>
      ) : overview.isError ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<HeartPulseIcon />}
            title="Couldn't score this stack"
            description={overview.error.message}
            action={
              <Button variant="outline" onClick={() => void overview.refetch()}>
                Retry
              </Button>
            }
          />
        </div>
      ) : overview.data ? (
        <div className="space-y-6">
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
    </section>
  );
}
