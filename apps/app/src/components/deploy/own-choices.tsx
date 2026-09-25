import * as React from 'react';
import { cn } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { OWN_OPTIONS, type OwnKind } from './deploy-choice';

/** "Or bring your own": git, compose, image — plain at Summary, what swarmy generates at Controls. */
export function OwnChoices({
  value,
  onPick,
}: {
  value: OwnKind | null;
  onPick: (k: OwnKind) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2.5">
      <h2 className="calm-eyebrow">Or bring your own</h2>
      <div className="grid gap-2.5 sm:grid-cols-3">
        {OWN_OPTIONS.map((o) => (
          <button
            key={o.kind}
            type="button"
            aria-pressed={value === o.kind}
            onClick={() => onPick(o.kind)}
            className={cn(
              'calm-card flex min-h-11 flex-col gap-1 px-4 py-3 text-left outline-none transition-colors',
              'hover:bg-foreground/[0.025] focus-visible:ring-ring/60 focus-visible:ring-2',
              value === o.kind && 'ring-primary/70 ring-2',
            )}
          >
            <span className="text-[14px] font-semibold">{o.title}</span>
            <span className="text-muted-foreground text-[12.5px]">{o.say}</span>
            <Tech className="text-[11px]">{o.tech}</Tech>
          </button>
        ))}
      </div>
    </div>
  );
}
