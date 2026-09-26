import * as React from 'react';
import type { BlueprintMetaView } from '@swarmy/core';
import { TemplateCard } from './template-card';

const GRID = 'grid grid-cols-1 gap-2.5 @min-[20rem]:grid-cols-2 @min-[34rem]:grid-cols-3 @min-[42rem]:grid-cols-4';

/** The dense template grid: 1 → 2 → 3 → 4 columns as the page widens. */
export function TemplateGrid({
  cards,
  selected,
  onPick,
  variant = 'gallery',
}: {
  cards: BlueprintMetaView[];
  selected: string | null;
  onPick: (id: string) => void;
  variant?: 'gallery' | 'hub';
}): React.JSX.Element {
  return (
    <div className="@container">
      <div className={GRID}>
        {cards.map((m) => (
          <TemplateCard key={m.id} meta={m} selected={m.id === selected} onPick={onPick} variant={variant} />
        ))}
      </div>
    </div>
  );
}

TemplateGrid.Skeleton = function TemplateGridSkeleton({ count = 8 }: { count?: number }): React.JSX.Element {
  return (
    <div className="@container">
      <div className={GRID}>
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="shimmer-line h-28 rounded-2xl" />
        ))}
      </div>
    </div>
  );
};
