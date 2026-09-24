import * as React from 'react';
import { Link, useMatchRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { BoxesIcon } from 'lucide-react';
import { cn, EmptyState } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { computeStackStats, type StackStat } from '@/components/canvas/stack-aggregates';
import { StackHeader } from './stack-header';

interface StackWorkspaceLayoutProps {
  stack: string;
  children: React.ReactNode;
}

/**
 * The stack workspace — a stack is the unit you operate, so everything an app
 * needs (data, messaging, observability, network, config, backups, releases)
 * lives here as a tab, each a real URL. One `StackHeader` sits above every
 * tab, unchanged between them.
 *
 * The Overview tab runs in "fit mode": the workspace caps itself to the
 * viewport (mobile: 100dvh minus the shell's 3.5rem header + 7rem tab-bar
 * clearance; lg: a clean h-dvh — nothing sits above <main>) so the canvas
 * always ends on screen with zero page scroll. Every other tab scrolls
 * normally. (Demo mode's banner adds height above <main> and is the one
 * accepted misfit.)
 */
export function StackWorkspaceLayout({
  stack,
  children,
}: StackWorkspaceLayoutProps): React.JSX.Element {
  const matchRoute = useMatchRoute();
  const fit = !!matchRoute({ to: '/stacks/$name' });
  const trpc = useTRPC();
  const inventory = useQuery({ ...trpc.inventory.get.queryOptions(), refetchInterval: 4_000 });
  const stat: StackStat | undefined = React.useMemo(
    () =>
      inventory.data
        ? computeStackStats(inventory.data).find((s) => s.name === stack)
        : undefined,
    [inventory.data, stack],
  );

  if (inventory.data && !stat) return <StackNotFound stack={stack} />;

  return (
    <div
      className={cn(
        'mx-auto flex w-full max-w-[1600px] flex-col px-6 pt-6 xl:px-10',
        fit
          ? 'h-[calc(100dvh-10.5rem)] min-h-[480px] overflow-hidden lg:h-dvh lg:pb-6'
          : 'lg:pb-10',
      )}
    >
      <StackHeader stack={stack} stat={stat} />
      <div className="min-h-0 flex-1 pt-5">{children}</div>
    </div>
  );
}

function StackNotFound({ stack }: { stack: string }): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 xl:px-10">
      <EmptyState
        icon={<BoxesIcon />}
        title={`No stack called “${stack}”.`}
        description="It may have been removed, or it hasn't converged yet. Head back to your stacks."
        action={
          <Link to="/" className="text-primary font-semibold">
            ← All stacks
          </Link>
        }
      />
    </div>
  );
}
