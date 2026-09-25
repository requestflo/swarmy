import * as React from 'react';
import { BotIcon, ChevronRightIcon, CpuIcon, KeyRoundIcon, UserIcon } from 'lucide-react';
import { Collapsible, CollapsibleContent, cn } from '@swarmy/ui';
import type { AuditActorKind, AuditEntryView } from '@swarmy/core';
import { Tech } from '@/components/calm';
import { relTime } from '@/lib/format';
import { humanizeAction } from './humanize';
import { AuditRowDetail } from './audit-row-detail';

const ACTOR_ICON: Record<AuditActorKind, React.ComponentType<{ className?: string }>> = {
  user: UserIcon,
  apikey: KeyRoundIcon,
  system: BotIcon,
  agent: CpuIcon,
};

interface AuditRowProps {
  entry: AuditEntryView;
  expanded: boolean;
  onToggle: () => void;
}

/** One line: when · who · what they did. The raw action and ids show from Controls; the row opens the full record. */
export function AuditRow({ entry, expanded, onToggle }: AuditRowProps): React.JSX.Element {
  const Icon = ACTOR_ICON[entry.actorType];
  return (
    <div className={cn('border-border border-b last:border-b-0', expanded && 'bg-foreground/[0.03] rounded-md')}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="hover:bg-foreground/[0.025] flex min-h-14 w-full items-start gap-3 rounded-sm px-1 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className="text-muted-foreground w-16 shrink-0 pt-0.5 font-mono text-[11.5px]" title={new Date(entry.ts).toLocaleString()}>
          {relTime(entry.ts)}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2 text-[14px]">
            <Icon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
            <b className="shrink-0 font-semibold">{entry.actorLabel}</b>
            <span className="text-muted-foreground min-w-0 truncate">{humanizeAction(entry).replace(/^deployed stack/, 'deployed app')}</span>
          </span>
          <Tech>{`${entry.action}${entry.targetType ? ` · ${entry.targetType}/${entry.targetId ?? ''}` : ''} · ${entry.actorType}:${entry.actorId ?? '—'}`}</Tech>
        </span>
        <ChevronRightIcon aria-hidden className={cn('text-muted-foreground mt-1 size-4 shrink-0 transition-transform', expanded && 'rotate-90')} />
      </button>
      <Collapsible open={expanded}>
        <CollapsibleContent>
          <AuditRowDetail entry={entry} />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
