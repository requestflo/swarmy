import * as React from 'react';
import { ChevronDownIcon } from 'lucide-react';
import type { SecretFamilyView } from '@swarmy/core';
import {
  Collapsible,
  CollapsibleContent,
  StatusBadge,
  cn,
  type StatusTone,
} from '@swarmy/ui';
import { relTime } from '@/lib/format';
import { ConsumerChips } from './consumer-chips';
import { SecretRowExpand } from './secret-row-expand';

/** Row tone: stale consumers need a rotation nudge; unattached is just quiet. */
export function secretTone(f: SecretFamilyView): { tone: StatusTone; label: string } {
  if (f.staleConsumers > 0) return { tone: 'warning', label: `${f.staleConsumers} stale` };
  if (f.usedByCount === 0) return { tone: 'neutral', label: 'unattached' };
  return { tone: 'online', label: 'in sync' };
}

interface SecretRowProps {
  family: SecretFamilyView;
  stack: string;
  expanded: boolean;
  onToggle: () => void;
}

/** One flat family row; clicking expands the full detail inline underneath. */
export function SecretRow({ family, stack, expanded, onToggle }: SecretRowProps): React.JSX.Element {
  const tone = secretTone(family);
  return (
    <div className={cn(expanded && 'bg-accent/40 shadow-[inset_3px_0_0_var(--primary)]')}>
      <button
        type="button"
        onClick={onToggle}
        className="hover:bg-accent/50 grid w-full grid-cols-[1fr_auto] items-center gap-3 px-5 py-3.5 text-left transition-colors lg:grid-cols-[1.6fr_1.4fr_7rem_6.5rem_1.5rem]"
      >
        <span className="min-w-0">
          <span className="mono-data block truncate text-sm font-semibold">{family.family}</span>
          <span className="text-muted-foreground block truncate text-xs">
            {family.versions.length} version{family.versions.length === 1 ? '' : 's'} · v
            {family.currentVersion} current
          </span>
        </span>
        <span className="hidden min-w-0 lg:block">
          <ConsumerChips consumers={family.consumers} />
        </span>
        <span className="mono-data text-muted-foreground hidden text-right text-xs lg:block">
          {relTime(family.lastRotatedAt)}
        </span>
        <span className="hidden justify-end lg:flex">
          <StatusBadge tone={tone.tone} label={tone.label} />
        </span>
        <span className="flex items-center justify-end gap-3">
          <span className="lg:hidden">
            <StatusBadge tone={tone.tone} label={tone.label} />
          </span>
          <ChevronDownIcon
            className={cn(
              'text-muted-foreground size-4 shrink-0 transition-transform',
              expanded && 'rotate-180',
            )}
          />
        </span>
      </button>
      <Collapsible open={expanded}>
        <CollapsibleContent>
          <SecretRowExpand family={family} stack={stack} />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
