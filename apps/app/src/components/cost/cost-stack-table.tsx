import * as React from 'react';
import { LayersIcon } from 'lucide-react';
import type { CostStackView } from '@swarmy/core';
import { EmptyState } from '@swarmy/ui';

/**
 * Per-stack estimated monthly cost. The estimate is each container's memory
 * share of its node (limit when configured, live usage otherwise) × the node's
 * monthly price — mirrors estimateStackCosts in cost.service.
 */
export function CostStackTable({ stacks }: { stacks: CostStackView[] }): React.JSX.Element {
  if (stacks.length === 0) {
    return (
      <div className="card-pop p-2">
        <EmptyState
          icon={<LayersIcon />}
          title="No stack estimates yet"
          description="Price your nodes and keep services running — swarmy attributes each stack's share of node spend by memory footprint."
        />
      </div>
    );
  }

  const total = stacks.reduce((a, s) => a + s.monthlyUsd, 0);

  return (
    <section className="card-pop overflow-hidden">
      <header className="border-border flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-5 py-3">
        <span className="mono-label !mb-0">Per-stack estimate</span>
        <span className="text-muted-foreground text-xs">
          Memory share of each node × node cost — unused capacity stays unattributed.
        </span>
      </header>
      <div className="divide-border divide-y">
        {stacks.map((s) => {
          const share = total > 0 ? (s.monthlyUsd / total) * 100 : 0;
          return (
            <div
              key={s.stack}
              className="hover:bg-accent/50 grid grid-cols-[1fr_auto] items-center gap-3 px-5 py-3.5 transition-colors"
            >
              <span className="min-w-0">
                <span className="mono-data block truncate text-sm font-semibold">{s.stack}</span>
                <span className="text-muted-foreground text-xs">
                  {s.serviceCount} service{s.serviceCount === 1 ? '' : 's'}
                  {s.partial ? ' · some nodes unpriced — estimate is a floor' : ''}
                </span>
                <span className="bg-secondary mt-1.5 block h-1 w-full max-w-[240px] overflow-hidden rounded-full">
                  <span
                    className="bg-primary block h-full rounded-full transition-all"
                    style={{ width: `${share}%` }}
                  />
                </span>
              </span>
              <span className="mono-data text-right text-sm font-bold">
                ${s.monthlyUsd.toLocaleString()}
                <span className="text-muted-foreground font-normal">/mo</span>
                {s.partial ? <span className="text-status-warning"> +</span> : null}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
