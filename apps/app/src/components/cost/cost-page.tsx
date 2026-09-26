import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Button } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CodeView, Say, Tech } from '@/components/calm';
import { ErrorState, SkeletonBody } from '@/components/states';
import { RowPage } from '@/components/rowpage/row-page';
import { bytes } from '@/lib/format';
import { CostBudgetCard } from './cost-budget-card';
import { CostBudgetSection } from './cost-budget-section';
import { costCode } from './cost-code';
import { CostNext } from './cost-next';
import { CostRecommendations } from './cost-recommendations';
import { CostServers } from './cost-servers';
import { CostSplit } from './cost-split';

const usd = (n: number): string => `$${Math.round(n).toLocaleString()}`;

/** Activity → Cost: what it costs a month, which app spends it, and what you could save. */
export function CostPage(): React.JSX.Element {
  const trpc = useTRPC();
  const overview = useQuery({ ...trpc.cost.overview.queryOptions(), refetchInterval: 10_000 });
  const storage = useQuery({ ...trpc.cost.storage.queryOptions(), refetchInterval: 60_000 });
  const recs = useQuery({ ...trpc.cost.recommendations.queryOptions(), refetchInterval: 30_000 });
  const budget = useQuery({ ...trpc.cost.budget.queryOptions(), refetchInterval: 30_000 });
  const o = overview.data;
  const status = budget.data?.status ?? null;
  const save = (recs.data ?? []).reduce((a, r) => a + (r.savingsUsd ?? 0), 0);

  const title = !o ? (
    'What it costs.'
  ) : o.nodes.length === 0 ? (
    <>
      Nothing to pay for yet. <em>Add a server first.</em>
    </>
  ) : o.totals.pricedNodes === 0 ? (
    <>
      Price your servers. <em>Then swarmy splits the bill by app.</em>
    </>
  ) : status ? (
    <>
      {usd(o.totals.monthlyUsd)} of {usd(status.budgetUsd)} this month.{' '}
      {status.state === 'over' ? (
        <Say tone="bad">Over budget.</Say>
      ) : status.state === 'warn' ? (
        <Say tone="warn">Over {status.warnPct}% of budget.</Say>
      ) : (
        <em>On track.</em>
      )}
      {save > 0 ? (
        <>
          {' '}
          <Say tone="ok">You could save {usd(save)}.</Say>
        </>
      ) : null}
    </>
  ) : (
    <>
      {usd(o.totals.monthlyUsd)} a month.{' '}
      {save > 0 ? <Say tone="ok">You could save {usd(save)}.</Say> : <em>Nothing to trim.</em>}
    </>
  );
  const lede = o && o.totals.pricedNodes > 0
    ? `${usd(o.totals.allocatedUsd)} goes to your apps; the rest is spare room. ${o.totals.pricedNodes} of ${o.totals.totalNodes} servers priced. Prices come from each server, not a bill.`
    : 'Set each server’s monthly price and swarmy breaks spend down per app, spots idle apps and oversized servers, and suggests savings.';

  return (
    <RowPage
      title={title}
      description={lede}
      aside={
        o ? (
          <>
            <CodeView
              title="Cost as code"
              tabs={costCode(o, budget.data)}
              source="readonly"
              note="Server prices are labels on each server. The budget is a dashboard setting saved from this page (no REST route yet)."
            />
            <CostRecommendations recommendations={recs.data ?? []} isLoading={recs.isLoading} />
          </>
        ) : undefined
      }
    >
      {overview.isLoading ? (
        <SkeletonBody variant="list" />
      ) : overview.isError ? (
        <ErrorState title="Couldn’t load cost." error={overview.error} retry={() => void overview.refetch()} />
      ) : !o || o.nodes.length === 0 ? (
        <Button asChild className="w-fit pointer-coarse:min-h-11">
          <Link to="/nodes/new">Add a server</Link>
        </Button>
      ) : (
        <>
          {o.totals.pricedNodes > 0 ? <CostBudgetCard o={o} budget={budget.data} /> : null}
          <CostNext o={o} recs={recs.data ?? []} budget={budget.data} />
          {o.totals.pricedNodes > 0 ? <CostBudgetSection /> : null}
          {o.totals.pricedNodes > 0 ? <CostSplit stacks={o.stacks} monthlyUsd={o.totals.monthlyUsd} allocatedUsd={o.totals.allocatedUsd} /> : null}
          <CostServers nodes={o.nodes} />
          {storage.data ? (
            <Tech>{`storage · object store ${storage.data.garageState} · ${storage.data.bucketCount} buckets · ${storage.data.objectCount} objects · ${bytes(storage.data.usageBytes)} · ${storage.data.volumeCount} volumes · ${o.totals.idleServiceCount} idle services`}</Tech>
          ) : null}
        </>
      )}
    </RowPage>
  );
}
