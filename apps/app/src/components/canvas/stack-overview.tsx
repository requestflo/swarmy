import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { LayoutGridIcon, RocketIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import type { Inventory } from '@swarmy/core';
import { PageHeader } from '@/components/page-header';
import { CountUp } from '@/components/count-up';
import { StackCard } from './stack-card';
import { computeStackStats } from './stack-aggregates';

interface StackOverviewProps {
  inv: Inventory;
  onOpenStack: (name: string) => void;
  onShowAll: () => void;
}

/**
 * The Applications home — the "magic": swarmy discovers every Docker stack on the
 * swarm and groups it into a premium card grid (aggregate status, replica health,
 * service + inferred-link counts). Clicking a stack drills into its service-level
 * canvas; "All services" drops to the flat cross-swarm canvas.
 */
export function StackOverview({
  inv,
  onOpenStack,
  onShowAll,
}: StackOverviewProps): React.JSX.Element {
  const navigate = useNavigate();
  const stats = React.useMemo(() => computeStackStats(inv), [inv]);
  const count = stats.length;

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Applications"
        title={
          <>
            <CountUp value={count} /> stack{count === 1 ? '' : 's'} <em>discovered</em>.
          </>
        }
        description="Every app on your swarm, grouped by stack. Open one to arrange its services."
        actions={
          <>
            <Button variant="outline" onClick={onShowAll}>
              <LayoutGridIcon className="size-4" /> All services
            </Button>
            <Button onClick={() => navigate({ to: '/services/new' })}>
              <RocketIcon className="size-4" /> Deploy
            </Button>
          </>
        }
      />
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
        {stats.map((stat) => (
          <StackCard key={stat.name} stat={stat} onOpen={() => onOpenStack(stat.name)} />
        ))}
      </div>
    </div>
  );
}
