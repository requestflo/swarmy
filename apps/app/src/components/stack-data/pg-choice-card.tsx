import * as React from 'react';
import { cn } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import type { ChoiceFacts } from './pg-choices';

/**
 * One of the three honest choices (RDatabase board): a real radio input inside
 * a label, so the whole card is the hit target and arrow keys move between
 * choices. The selected card gets the coral rail; "today" marks the current one.
 */
export function PgChoiceCard({
  name,
  value,
  facts,
  selected,
  current,
  recommended,
  blocked,
  onSelect,
}: {
  name: string;
  value: string;
  facts: ChoiceFacts;
  selected: boolean;
  current: boolean;
  recommended: boolean;
  /** Why this choice can't work here (it stays visible, disabled). */
  blocked?: string | null;
  onSelect: () => void;
}): React.JSX.Element {
  return (
    <label
      className={cn(
        'border-border flex cursor-pointer gap-3 rounded-xl border px-4 py-3.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50',
        selected ? 'border-primary/70 bg-primary/[0.05]' : 'hover:bg-foreground/[0.02]',
        blocked && 'cursor-not-allowed opacity-70',
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={selected}
        disabled={!!blocked}
        onChange={onSelect}
        className="accent-primary mt-1 size-4 shrink-0"
      />
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] font-semibold">{facts.title}</span>
          {current ? <span className="bg-muted text-muted-foreground rounded-md px-1.5 py-0.5 text-[11px] font-semibold">today</span> : null}
          {recommended ? (
            <span className="border-tone-ok/50 text-tone-ok rounded-md border px-1.5 py-0.5 text-[11px] font-semibold">recommended</span>
          ) : null}
        </span>
        <span className="text-muted-foreground text-[13.5px] leading-relaxed">{facts.say}</span>
        <span className="flex flex-wrap gap-x-5 gap-y-0.5 text-[12.5px]">
          <span className="text-muted-foreground">
            Down for <b className="text-foreground font-semibold">{facts.down}</b>
          </span>
          <span className="text-muted-foreground">
            Could lose <b className="text-foreground font-semibold">{facts.lose}</b>
          </span>
          <span className="text-muted-foreground">
            Costs <b className="text-foreground font-semibold">{facts.cost}</b>
          </span>
        </span>
        {blocked ? <span className="text-tone-warn text-[12.5px]">{blocked}</span> : null}
        <Tech>{facts.tech}</Tech>
      </span>
    </label>
  );
}
