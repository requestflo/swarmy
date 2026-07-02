import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeftIcon, BoxesIcon } from 'lucide-react';
import { EmptyState } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { computeStackStats, type StackStat } from '@/components/canvas/stack-aggregates';
import { StackTabStrip } from './stack-tab-strip';

interface StackWorkspaceLayoutProps {
  stack: string;
  children: React.ReactNode;
}

interface TonePhrase {
  word: string;
  sentence: string;
}

const IDLE_PHRASE: TonePhrase = { word: 'idle', sentence: 'Sitting' };

const TONE_WORD: Record<string, TonePhrase> = {
  online: { word: 'green', sentence: 'All' },
  progress: { word: 'converging', sentence: 'Still' },
  warning: { word: 'you', sentence: 'Needs' },
  offline: { word: 'down', sentence: 'Something is' },
  idle: IDLE_PHRASE,
};

/**
 * The stack workspace — a stack is the unit you operate, so everything an app
 * needs (data, messaging, observability, network, config, backups, releases)
 * lives here as a tab, each a real URL. The header stays lightweight: back
 * link, the stack's health as a statement, live counts, then the tab strip.
 */
export function StackWorkspaceLayout({
  stack,
  children,
}: StackWorkspaceLayoutProps): React.JSX.Element {
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

  const tone = stat?.tone ?? 'idle';
  const phrase = TONE_WORD[tone] ?? IDLE_PHRASE;

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col px-6 pt-6 lg:pb-10 xl:px-10">
      <Link
        to="/"
        className="text-muted-foreground hover:text-foreground mb-3 inline-flex w-fit items-center gap-1.5 text-sm font-medium transition-colors"
      >
        <ArrowLeftIcon className="size-3.5" /> Stacks
      </Link>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow mb-2">Stack</div>
          <h1 className="headline text-[2rem] leading-[1.05] sm:text-4xl">
            {stack}
            {stat && (
              <span className="text-muted-foreground/80 font-display ml-3 text-[0.55em] font-semibold">
                {phrase.sentence} <em>{phrase.word}</em>.
              </span>
            )}
          </h1>
        </div>
        {stat && (
          <div className="mono-data text-muted-foreground flex items-center gap-4 pb-1 text-sm">
            <span className="flex items-center gap-2">
              <span
                className="size-2 rounded-full"
                style={{ background: `var(--status-${tone})` }}
              />
              {stat.serviceCount} service{stat.serviceCount === 1 ? '' : 's'}
            </span>
            <span>
              {stat.running}/{stat.desired} replicas
            </span>
          </div>
        )}
      </div>

      <StackTabStrip stack={stack} />

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
