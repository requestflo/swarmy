import * as React from 'react';
import { cn } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import type { ReplayPart } from './time-travel-replay';

/** "ghcr.io/northwind/storefront-web:1.8.2" → "storefront-web:1.8.2". */
const shortImage = (image: string): string => image.slice(image.lastIndexOf('/') + 1);

/** One part as it ran at T: its image then, and whether it has changed since. `data-flow` anchors the call lines. */
export function PartCard({ p, live, className }: { p: ReplayPart; live: boolean; className?: string }): React.JSX.Element {
  const note = live || !p.changed ? 'unchanged' : p.nowTag ? `${p.tag} → ${p.nowTag} since` : 'removed since';
  return (
    <li data-flow={p.name} className={cn('border-border bg-card relative flex min-w-0 flex-col gap-1 rounded-xl border px-3.5 py-3', !live && p.changed && 'border-tone-info/50', className)}>
      <span className="flex items-center gap-2">
        <span aria-hidden className="bg-status-online size-2 shrink-0 rounded-full" />
        <span className="truncate text-[14px] font-semibold">{p.name}</span>
      </span>
      <span className="truncate font-mono text-[12px]">{shortImage(p.image)}</span>
      <span className={cn('font-mono text-[11px]', !live && p.changed ? 'text-tone-info' : 'text-muted-foreground')}>{note}</span>
      <Tech className="truncate">{p.image}</Tech>
    </li>
  );
}
