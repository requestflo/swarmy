import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowLeftIcon, ShieldIcon } from 'lucide-react';
import { isSystemStack } from '@swarmy/core';
import type { StackStat } from '@/components/canvas/stack-aggregates';
import { TextSkeleton } from '@/components/states';
import { StackTabStrip } from './stack-tab-strip';

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

interface StackHeaderProps {
  stack: string;
  /** Live aggregate for this stack; undefined while the inventory is loading. */
  stat: StackStat | undefined;
}

/**
 * The one header every stack workspace tab shares: `← Stacks` breadcrumb,
 * eyebrow, the stack name with its health as a statement, live counts, then
 * the tab strip. Identical on every tab — including the Overview canvas — so
 * nothing jumps when you switch. Counts shimmer until the inventory lands.
 */
export function StackHeader({ stack, stat }: StackHeaderProps): React.JSX.Element {
  const isSystem = isSystemStack(stack);
  const tone = stat?.tone ?? 'idle';
  const phrase = TONE_WORD[tone] ?? IDLE_PHRASE;

  return (
    <header>
      <Link
        to="/"
        className="text-muted-foreground hover:text-foreground mb-3 inline-flex w-fit items-center gap-1.5 text-sm font-medium transition-colors"
      >
        <ArrowLeftIcon className="size-3.5" /> Stacks
      </Link>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          {isSystem ? (
            <div className="border-border text-muted-foreground mb-2 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold tracking-wide uppercase">
              <ShieldIcon className="size-3.5" /> System · managed by swarmy
            </div>
          ) : (
            <div className="eyebrow mb-2">Stack</div>
          )}
          <h1 className="headline text-2xl leading-[1.05] sm:text-3xl">
            {stack}
            {stat && (
              <span className="text-muted-foreground/80 font-display ml-3 text-[0.55em] font-semibold">
                {phrase.sentence} <em>{phrase.word}</em>.
              </span>
            )}
          </h1>
        </div>
        <div className="mono-data text-muted-foreground flex items-center gap-4 pb-1 text-sm">
          {stat ? (
            <>
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
            </>
          ) : (
            <>
              <TextSkeleton className="w-20" />
              <TextSkeleton className="w-16" />
            </>
          )}
        </div>
      </div>

      <StackTabStrip stack={stack} />
    </header>
  );
}
