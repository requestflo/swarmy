import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { HeartPulseIcon } from 'lucide-react';
import { Button, EmptyState } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { DrillCards } from './drill-cards';
import { DrillHistory } from './drill-history';
import { ProblemsList } from './problems-list';

interface StackResilienceSectionProps {
  stack: string;
}

/**
 * This stack's resilience in plain words: what isn't protected yet (each with
 * its fix), and the safe drills that prove a restore works.
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
          <span className="mono-label">What isn’t protected yet</span>
          <p className="text-muted-foreground mt-0.5 text-xs">
            What {stack} would lose if a server, a region or the whole cluster went away.
          </p>
        </div>
      </div>

      {overview.isLoading ? (
        <div className="card-pop space-y-3 p-5">
          {[0, 1].map((i) => (
            <div key={i} className="shimmer-line h-14 rounded-lg" />
          ))}
        </div>
      ) : overview.isError ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<HeartPulseIcon />}
            title="Couldn't check this stack"
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
          <ProblemsList problems={overview.data.problems} />
          <DrillCards drills={overview.data.drills} targets={overview.data.drillTargets} />
          <DrillHistory history={history.data ?? []} isLoading={history.isLoading} />
        </div>
      ) : null}
    </section>
  );
}
