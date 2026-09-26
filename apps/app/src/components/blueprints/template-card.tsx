import * as React from 'react';
import type { BlueprintMetaView } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { LetterAvatar } from './letter-avatar';
import { MANAGED_CHIP, categoryLabel, memoryLabel, servicesLabel } from './template-words';

function Chip({ tone, children }: { tone: 'warn' | 'info' | 'idle'; children: React.ReactNode }): React.JSX.Element {
  return (
    <span
      className={cn(
        'rounded-md px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap',
        tone === 'warn' && 'bg-status-warning/15 text-tone-warn',
        tone === 'info' && 'bg-status-progress/12 text-tone-info',
        tone === 'idle' && 'bg-muted text-muted-foreground',
      )}
    >
      {children}
    </span>
  );
}

/**
 * One template: a real button (picking fills the aside). `gallery` (the
 * Templates page) shows the pinned version and memory/managed-data chips;
 * `hub` (the Deploy page) shows the category and `~MB · N services`.
 */
export function TemplateCard({
  meta,
  selected,
  onPick,
  variant = 'gallery',
}: {
  meta: BlueprintMetaView;
  selected: boolean;
  onPick: (id: string) => void;
  variant?: 'gallery' | 'hub';
}): React.JSX.Element {
  const mem = memoryLabel(meta);
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onPick(meta.id)}
      className={cn(
        'calm-card flex min-h-11 min-w-0 flex-col gap-2 px-3.5 py-3 text-left outline-none transition-colors',
        'hover:bg-foreground/[0.025] focus-visible:ring-ring/60 focus-visible:ring-2',
        selected && 'border-primary ring-primary/30 ring-2',
      )}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <LetterAvatar id={meta.id} name={meta.name} size="sm" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[14px] leading-tight font-semibold">{meta.name}</span>
          <span className="text-muted-foreground truncate font-mono text-[11px]">
            {variant === 'hub' ? categoryLabel(meta) : meta.version ? `v${meta.version}` : categoryLabel(meta)}
          </span>
        </span>
      </span>
      <span className="text-muted-foreground line-clamp-2 text-[12.5px] leading-snug">{meta.tagline}</span>
      {variant === 'hub' ? (
        <span className="text-muted-foreground mt-auto font-mono text-[11px]">
          {[mem, servicesLabel(meta)].filter(Boolean).join(' · ')}
        </span>
      ) : (
        <span className="mt-auto flex flex-wrap gap-1">
          {mem ? <Chip tone={meta.heavy ? 'warn' : 'idle'}>{meta.heavy ? `${mem} RAM` : mem}</Chip> : null}
          {(meta.managed ?? []).map((m) => (
            <Chip key={m} tone="info">
              {MANAGED_CHIP[m] ?? m}
            </Chip>
          ))}
        </span>
      )}
    </button>
  );
}
