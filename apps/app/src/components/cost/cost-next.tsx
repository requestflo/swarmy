import * as React from 'react';
import { Link } from '@tanstack/react-router';
import type { CostBudgetView, CostOverviewView, CostRecommendationView } from '@swarmy/core';
import { Button } from '@swarmy/ui';
import { NextAction, usePageDepth } from '@/components/calm';

/**
 * The one thing worth doing on Cost: price the servers first; then set a
 * monthly budget (owner decision Q6); then look at the biggest saving.
 */
export function CostNext({
  o,
  recs,
  budget,
}: {
  o: CostOverviewView;
  recs: CostRecommendationView[];
  budget: CostBudgetView | undefined;
}): React.JSX.Element | null {
  const { depth, setDepth } = usePageDepth();
  const unpriced = o.nodes.filter((n) => n.monthlyUsd == null);
  const openAt = (id: string): void => {
    if (depth === 'summary') setDepth('controls');
    window.requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  };
  const openEditors = (): void => openAt('server-prices');
  if (o.totals.pricedNodes === 0 || unpriced.length > 0) {
    return (
      <NextAction
        title={o.totals.pricedNodes === 0 ? 'Tell swarmy what your servers cost.' : `${unpriced.length} of ${o.nodes.length} servers have no price yet.`}
        tech="stored as the swarmy.node.cost label on each server"
        actions={
          <Button className="pointer-coarse:min-h-11" onClick={openEditors}>
            Set prices
          </Button>
        }
      >
        Put in the monthly price you pay your host. Every total, per-app split and saving works from that.
      </NextAction>
    );
  }
  if (budget && budget.monthlyUsd == null) {
    return (
      <NextAction
        title="Set a monthly budget."
        tech="cost.setBudget · the cost-budget alert rule warns at 80% by default"
        actions={
          <Button className="pointer-coarse:min-h-11" onClick={() => openAt('budget')}>
            Set a monthly budget
          </Button>
        }
      >
        swarmy warns your channels when the month is on track to pass it, and can send a short summary every Monday. It never stops a deploy.
      </NextAction>
    );
  }
  const best = [...recs].filter((r) => r.savingsUsd != null).sort((a, b) => (b.savingsUsd ?? 0) - (a.savingsUsd ?? 0))[0];
  if (!best) return null;
  const idle = o.idleServices.find((s) => best.resource.includes(s.name));
  const big = o.oversizedNodes.find((n) => best.resource.includes(n.name));
  const link = idle ? (
    <Link to="/services/$serviceId" params={{ serviceId: idle.serviceId }}>Look at {idle.name}</Link>
  ) : big ? (
    <Link to="/nodes/$nodeId" params={{ nodeId: big.nodeId }}>Look at {big.name}</Link>
  ) : null;
  return (
    <NextAction
      eyebrow="Biggest saving"
      tone="ok"
      title={best.message}
      tech={best.tech ?? `${best.kind} · ${best.resource} · about $${best.savingsUsd}/mo`}
      actions={link ? <Button asChild className="pointer-coarse:min-h-11">{link}</Button> : undefined}
    >
      A guess from the last days of usage. Nothing changes until you do it.
    </NextAction>
  );
}
