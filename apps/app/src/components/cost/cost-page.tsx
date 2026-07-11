import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { CircleDollarSignIcon } from 'lucide-react';
import { Button, EmptyState } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { SectionHeader } from '@/components/section-header';
import { CostNodeTable } from './cost-node-table';
import { CostRecommendations } from './cost-recommendations';
import { CostStackTable } from './cost-stack-table';
import { CostStatTiles } from './cost-stat-tiles';

/**
 * Governance → Cost: what the estate costs and where it's wasted — stat tiles,
 * the per-node table (inline price editing), per-stack estimates and the
 * recommendations feed.
 */
export function CostPage(): React.JSX.Element {
  const trpc = useTRPC();

  const overview = useQuery({ ...trpc.cost.overview.queryOptions(), refetchInterval: 10_000 });
  const storage = useQuery({ ...trpc.cost.storage.queryOptions(), refetchInterval: 60_000 });
  const recs = useQuery({ ...trpc.cost.recommendations.queryOptions(), refetchInterval: 30_000 });

  const o = overview.data;
  const pricedNodes = o?.totals.pricedNodes ?? 0;

  const title =
    o == null || o.nodes.length === 0 ? (
      <>
        What does it <em>cost</em>?
      </>
    ) : pricedNodes === 0 ? (
      <>
        Price your <em>nodes</em>.
      </>
    ) : (
      <>
        ${Math.round(o.totals.monthlyUsd).toLocaleString()}
        <span className="text-muted-foreground">/mo</span> — <em>${Math.round(o.totals.allocatedUsd).toLocaleString()}</em> doing work.
      </>
    );

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <SectionHeader
        section="Governance"
        title={title}
        description="Set each node's monthly price and swarmy breaks spend down per stack, spots idle services and oversized nodes, and suggests savings."
      />

      {overview.isLoading ? (
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="shimmer-line h-28 rounded-2xl" />
          ))}
        </div>
      ) : overview.isError ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<CircleDollarSignIcon />}
            title="Couldn't load cost data"
            description={overview.error.message}
            action={
              <Button variant="outline" onClick={() => void overview.refetch()}>
                Retry
              </Button>
            }
          />
        </div>
      ) : o == null || o.nodes.length === 0 ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<CircleDollarSignIcon />}
            title="No nodes yet"
            description="Add a node first — then set what it costs per month and swarmy takes care of the breakdown."
          />
        </div>
      ) : (
        <>
          {pricedNodes === 0 ? (
            <div className="ink-block mb-8 rounded-2xl p-6">
              <p className="headline text-xl sm:text-2xl">
                Start here: set a monthly cost on a node below.
              </p>
              <p className="text-ink-foreground/70 mt-1 text-sm">
                Click “Set cost” next to any node — the price lives on the node itself, and every
                total, stack estimate and recommendation lights up from there.
              </p>
            </div>
          ) : (
            <CostStatTiles overview={o} storage={storage.data} />
          )}

          <div className="grid gap-6 lg:grid-cols-[1fr_400px]">
            <div className="min-w-0 space-y-6">
              <CostNodeTable nodes={o.nodes} />
              <CostStackTable stacks={o.stacks} />
            </div>
            <div className="min-w-0">
              <CostRecommendations
                recommendations={recs.data ?? []}
                isLoading={recs.isLoading}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
