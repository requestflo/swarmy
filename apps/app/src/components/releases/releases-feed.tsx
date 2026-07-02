import * as React from 'react';
import type { ReleaseView } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { ReleaseStatusChip, relativeTime } from './release-status';

interface ReleasesFeedProps {
  releases: ReleaseView[];
  selectedId: string | null;
  onSelect: (release: ReleaseView) => void;
}

/** Org-wide deploy feed — flat rows in one card, divided by hairlines. */
export function ReleasesFeed({ releases, selectedId, onSelect }: ReleasesFeedProps): React.JSX.Element {
  return (
    <div>
      {releases.map((r) => {
        const selected = r.id === selectedId;
        const firstImage = r.images[0]?.image ?? '—';
        const extra = r.images.length - 1;
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => onSelect(r)}
            className={cn(
              'hover:bg-accent/50 flex w-full items-center gap-4 border-b px-6 py-3.5 text-left transition-colors last:border-b-0',
              selected && 'bg-accent border-l-primary border-l-[3px] pl-[21px]',
            )}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium">{r.stackName}</span>
                {r.notes?.toLowerCase().includes('rollback') ? (
                  <span className="mono-label text-status-warning shrink-0">rollback</span>
                ) : null}
              </div>
              <p className="mono-label text-muted-foreground truncate">
                {firstImage}
                {extra > 0 ? ` +${extra}` : ''}
              </p>
            </div>
            <div className="hidden shrink-0 text-right sm:block">
              <p className="text-muted-foreground truncate text-xs">{r.actor ?? 'system'}</p>
              <p className="mono-label text-muted-foreground">{relativeTime(r.createdAt)}</p>
            </div>
            <div className="shrink-0">
              <ReleaseStatusChip status={r.status} />
            </div>
          </button>
        );
      })}
    </div>
  );
}
