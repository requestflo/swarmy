import * as React from 'react';
import { BotIcon, CpuIcon, KeyRoundIcon, UserIcon } from 'lucide-react';
import { StatusBadge } from '@swarmy/ui';
import type { AuditActorKind, AuditEntryView } from '@swarmy/core';
import { relTime } from '@/lib/format';
import { actionTone, humanizeAction } from './humanize';

const ACTOR_ICON: Record<AuditActorKind, React.ComponentType<{ className?: string }>> = {
  user: UserIcon,
  apikey: KeyRoundIcon,
  system: BotIcon,
  agent: CpuIcon,
};

/** One timeline row: time · actor · humanized sentence · raw action chip. */
export function AuditRow({
  entry,
  onSelect,
}: {
  entry: AuditEntryView;
  onSelect: (entry: AuditEntryView) => void;
}): React.JSX.Element {
  const Icon = ACTOR_ICON[entry.actorType];
  return (
    <button
      type="button"
      onClick={() => onSelect(entry)}
      className="hover:bg-accent grid w-full grid-cols-[7rem_1fr] items-center gap-x-4 gap-y-1 px-4 py-3 text-left transition-colors sm:grid-cols-[7rem_13rem_1fr_auto]"
    >
      <span className="mono-data text-muted-foreground text-xs" title={new Date(entry.ts).toLocaleString()}>
        {relTime(entry.ts)}
      </span>
      <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
        <Icon className="text-muted-foreground size-4 shrink-0" />
        <span className="truncate">{entry.actorLabel}</span>
      </span>
      <span className="col-span-2 min-w-0 truncate text-sm sm:col-span-1">
        {humanizeAction(entry)}
      </span>
      <span className="hidden sm:block">
        <StatusBadge tone={actionTone(entry.action)} label={entry.action} className="mono-data" />
      </span>
    </button>
  );
}
