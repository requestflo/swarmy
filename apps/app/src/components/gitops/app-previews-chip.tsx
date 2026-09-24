import * as React from 'react';
import { StatusBadge } from '@swarmy/ui';
import type { AppPreview } from './gitops-types';
import { planStatus } from './plan-status';

interface AppPreviewsChipProps {
  previews: AppPreview[];
  onOpen: (planId: string) => void;
}

/** The previews slot of the strip: how many PRs have a live preview, and the newest one's state. */
export function AppPreviewsChip({
  previews,
  onOpen,
}: AppPreviewsChipProps): React.JSX.Element | null {
  const newest = [...previews].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (!newest) return null;
  return (
    <button
      type="button"
      onClick={() => onOpen(newest.planId)}
      className="hover:bg-accent/60 flex min-w-44 flex-1 flex-col gap-1 rounded-xl border border-dashed px-4 py-3 text-left transition-colors"
    >
      <span className="flex items-baseline justify-between gap-3">
        <span className="font-medium">
          {previews.length} preview{previews.length === 1 ? '' : 's'}
        </span>
        <span className="text-muted-foreground mono-label">#{newest.pr}</span>
      </span>
      <StatusBadge {...planStatus(newest.status)} />
    </button>
  );
}
