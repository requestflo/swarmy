import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { cn } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { SOURCE_CARDS, roundedCount, type DeploySource, type SourceCard } from './deploy-choice';

const CARD =
  'calm-card flex min-h-11 min-w-0 items-center gap-3 px-3.5 py-3 text-left outline-none transition-colors hover:bg-foreground/[0.025] focus-visible:ring-2 focus-visible:ring-ring/60';

function Body({ card, count }: { card: SourceCard; count: number | null }): React.JSX.Element {
  const Icon = card.icon;
  return (
    <>
      <span className="bg-muted text-foreground/80 flex size-9 shrink-0 items-center justify-center rounded-[10px]">
        <Icon aria-hidden className="size-4" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-[14px] leading-tight font-semibold">{card.title}</span>
        <span className="text-muted-foreground line-clamp-2 text-[12.5px] leading-snug">
          {card.key === 'template' && count ? `${card.say}, ${roundedCount(count)}` : card.say}
        </span>
        <Tech className="text-[10.5px]">{card.tech}</Tech>
      </span>
    </>
  );
}

/** The four ways in (board 2): the primary chooser. Template and git open here; compose and image have their own pages. */
export function SourceCards({
  value,
  onPick,
  templateCount,
}: {
  value: DeploySource;
  onPick: (s: DeploySource) => void;
  templateCount: number | null;
}): React.JSX.Element {
  return (
    <div role="group" aria-label="What you're deploying from" className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
      {SOURCE_CARDS.map((c) =>
        c.to ? (
          <Link key={c.key} to={c.to} className={CARD}>
            <Body card={c} count={templateCount} />
          </Link>
        ) : (
          <button
            key={c.key}
            type="button"
            aria-pressed={value === c.key}
            onClick={() => onPick(c.key as DeploySource)}
            className={cn(CARD, value === c.key && 'border-primary ring-primary/30 ring-2')}
          >
            <Body card={c} count={templateCount} />
          </button>
        ),
      )}
    </div>
  );
}
