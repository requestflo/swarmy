import * as React from 'react';
import type { BlueprintMetaView } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { BlueprintIcon } from './blueprint-icons';
import { memoryLabel } from './template-words';

/**
 * One template in the grid: a real button (picking fills the Configure
 * panel). Summary shows the name and the one-line "what you get"; Controls
 * adds the version, what it creates and its memory.
 */
export function TemplateCard({
  meta,
  selected,
  onPick,
}: {
  meta: BlueprintMetaView;
  selected: boolean;
  onPick: (id: string) => void;
}): React.JSX.Element {
  const mem = memoryLabel(meta);
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onPick(meta.id)}
      className={cn(
        'calm-card flex min-h-11 min-w-0 flex-col gap-2 px-4 py-3.5 text-left outline-none transition-colors',
        'focus-visible:ring-ring/60 hover:bg-foreground/[0.025] focus-visible:ring-2',
        selected && 'ring-primary/70 ring-2',
      )}
    >
      <span className="flex items-center gap-3">
        <span className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
          <BlueprintIcon id={meta.id} category={meta.category} className="size-4.5" />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[14.5px] font-semibold">{meta.name}</span>
          {meta.version ? <Tech className="truncate text-[11px]">v{meta.version}</Tech> : null}
        </span>
        {meta.heavy ? (
          <span className="text-tone-warn ml-auto shrink-0 text-[11px] font-semibold">{mem ?? 'Heavy'}</span>
        ) : null}
      </span>
      <span className="text-muted-foreground line-clamp-2 text-[13px] leading-snug">{meta.tagline}</span>
      <Tech className="text-[11px]">
        {[mem, ...meta.resources].filter(Boolean).join(' · ')}
      </Tech>
    </button>
  );
}
