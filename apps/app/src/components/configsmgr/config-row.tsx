import * as React from 'react';
import { ChevronDownIcon, FileCogIcon } from 'lucide-react';
import type { ConfigFamilyView } from '@swarmy/core';
import { Collapsible, CollapsibleContent, cn } from '@swarmy/ui';
import { StatusWord, Tech, type Tone } from '@/components/calm';
import { relTime } from '@/lib/format';
import { ConfigRowExpand } from './config-row-expand';

/** Row tone: a service on an old version needs an apply nudge; unattached is just quiet. */
export function configTone(f: ConfigFamilyView): { tone: Tone; label: string } {
  if (f.staleConsumers > 0) return { tone: 'warn', label: `${f.staleConsumers} on an old one` };
  if (f.usedByCount === 0) return { tone: 'idle', label: 'Not used' };
  return { tone: 'ok', label: 'In use' };
}

interface ConfigRowProps {
  family: ConfigFamilyView;
  stack: string;
  expanded: boolean;
  onToggle: () => void;
}

/** One config file: where it mounts and who reads it; expands for content, versions and apply. */
export function ConfigRow({ family, stack, expanded, onToggle }: ConfigRowProps): React.JSX.Element {
  const tone = configTone(family);
  const id = React.useId();
  const names = family.consumers.map((c) => c.serviceName);
  return (
    <li className={cn('border-border border-b last:border-b-0', expanded && 'bg-foreground/[0.02]')}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={id}
        className="hover:bg-foreground/[0.025] focus-visible:ring-ring/50 flex min-h-14 w-full items-center gap-3 rounded-sm px-1 py-2.5 text-left outline-none focus-visible:ring-2"
      >
        <span aria-hidden className="bg-foreground/[0.05] text-muted-foreground grid size-8 shrink-0 place-items-center rounded-lg">
          <FileCogIcon className="size-3.5" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate font-mono text-[13px] font-semibold">{family.family}</span>
          <span className="text-muted-foreground truncate text-[12.5px]">
            {names.length ? `Read by ${names.join(', ')}` : 'Not handed to any service yet'} · changed{' '}
            {relTime(family.lastUpdatedAt)}
          </span>
          <Tech>
            v{family.currentVersion} of {family.versions.length} · mounts at {family.mountPath}
          </Tech>
        </span>
        <StatusWord tone={tone.tone} word={tone.label} className="shrink-0" />
        <ChevronDownIcon
          aria-hidden
          className={cn('text-muted-foreground size-4 shrink-0 transition-transform', expanded && 'rotate-180')}
        />
      </button>
      <Collapsible open={expanded}>
        <CollapsibleContent id={id}>
          <ConfigRowExpand family={family} stack={stack} />
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}
