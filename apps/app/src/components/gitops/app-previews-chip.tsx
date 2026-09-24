import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { StatusBadge } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { planStatus } from './plan-status';

interface AppPreviewsChipProps {
  repoId: string;
  onOpen: (planId: string) => void;
}

/** The previews slot of the strip: how many PRs have a live preview, and the newest one's state. */
export function AppPreviewsChip({
  repoId,
  onOpen,
}: AppPreviewsChipProps): React.JSX.Element | null {
  const trpc = useTRPC();
  const plans = useQuery(
    trpc.apps.plans.queryOptions({ repoId, environment: 'preview', limit: 20 }),
  );
  if (!plans.data || plans.data.length === 0) return null;

  // Newest plan per PR.
  const byPr = new Map<number, (typeof plans.data)[number]>();
  for (const p of plans.data) if (p.prNumber && !byPr.has(p.prNumber)) byPr.set(p.prNumber, p);
  const newest = [...byPr.values()][0];
  if (!newest) return null;

  return (
    <button
      type="button"
      onClick={() => onOpen(newest.id)}
      className="hover:bg-accent/60 flex min-w-44 flex-1 flex-col gap-1 rounded-xl border border-dashed px-4 py-3 text-left transition-colors"
    >
      <span className="flex items-baseline justify-between gap-3">
        <span className="font-medium">
          {byPr.size} preview{byPr.size === 1 ? '' : 's'}
        </span>
        <span className="text-muted-foreground mono-label">#{newest.prNumber}</span>
      </span>
      <StatusBadge {...planStatus(newest.status)} />
    </button>
  );
}
