import * as React from 'react';
import { ChevronRightIcon } from 'lucide-react';
import type { SecretFamilyView } from '@swarmy/core';
import { StatusBadge, type StatusTone } from '@swarmy/ui';
import { relTime } from '@/lib/format';

/** Row tone: stale consumers need a rotation nudge; unused is just quiet. */
export function familyTone(f: SecretFamilyView): { tone: StatusTone; label: string } {
  if (f.staleConsumers > 0) return { tone: 'warning', label: `${f.staleConsumers} stale` };
  if (f.usedByCount === 0) return { tone: 'neutral', label: 'unused' };
  return { tone: 'online', label: 'in sync' };
}

/** Flat family rows in one card: name, current version, last rotated, usage. */
export function FamiliesTable({
  families,
  onOpen,
}: {
  families: SecretFamilyView[];
  onOpen: (f: SecretFamilyView) => void;
}): React.JSX.Element {
  return (
    <div className="card-pop overflow-hidden">
      <div className="text-muted-foreground mono-label hidden grid-cols-[1.8fr_5rem_9rem_6rem_7rem_1.5rem] items-center gap-3 border-b border-border px-5 py-2.5 !text-[10px] lg:grid">
        <span>Secret</span>
        <span className="text-right">Version</span>
        <span className="text-right">Last rotated</span>
        <span className="text-right">Used by</span>
        <span className="text-right">Status</span>
        <span />
      </div>
      <div className="divide-border divide-y">
        {families.map((f) => {
          const tone = familyTone(f);
          return (
            <button
              key={f.family}
              type="button"
              onClick={() => onOpen(f)}
              className="hover:bg-accent/50 grid w-full grid-cols-[1fr_auto] items-center gap-3 px-5 py-3.5 text-left transition-colors lg:grid-cols-[1.8fr_5rem_9rem_6rem_7rem_1.5rem]"
            >
              <span className="min-w-0">
                <span className="mono-data block truncate text-sm font-semibold">{f.family}</span>
                <span className="text-muted-foreground block truncate text-xs">
                  {f.versions.length} version{f.versions.length === 1 ? '' : 's'} · created{' '}
                  {relTime(f.createdAt)}
                </span>
              </span>
              <span className="mono-data hidden text-right text-sm lg:block">
                v{f.currentVersion}
              </span>
              <span className="mono-data text-muted-foreground hidden text-right text-xs lg:block">
                {relTime(f.lastRotatedAt)}
              </span>
              <span className="mono-data hidden text-right text-sm lg:block">
                {f.usedByCount}
              </span>
              <span className="hidden justify-end lg:flex">
                <StatusBadge tone={tone.tone} label={tone.label} />
              </span>
              <span className="flex items-center justify-end gap-3 lg:hidden">
                <span className="mono-data text-sm">v{f.currentVersion}</span>
                <StatusBadge tone={tone.tone} label={tone.label} />
              </span>
              <ChevronRightIcon className="text-muted-foreground hidden size-4 justify-self-end lg:block" />
            </button>
          );
        })}
      </div>
    </div>
  );
}
