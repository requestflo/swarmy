import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCwIcon } from 'lucide-react';
import { Badge, Button, cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { AppDrift, DriftEnv } from './gitops-types';
import { envLabel } from './plan-status';

interface AppDriftBadgeProps {
  repoId: string;
  /** The worker's cached check (AppView.drift). */
  drift: AppDrift | null;
  /** Only count this stack (the stack workspace panel). */
  stack?: string;
}

const ago = (iso: string): string => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

/** "Drifted · N" when live no longer matches the last applied commit, plus an explicit "Check now". */
export function AppDriftBadge({ repoId, drift, stack }: AppDriftBadgeProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  // Only runs when asked — the badge reads the worker's cached result.
  const check = useQuery({
    ...trpc.apps.drift.queryOptions({ repoId }),
    enabled: false,
    retry: false,
  });
  // Whichever check is newer: the worker's cached one or a "Check now" from here.
  const latest: AppDrift | null =
    check.data && (!drift || check.data.checkedAt >= drift.checkedAt) ? check.data : drift;
  const envs: DriftEnv[] = (latest?.environments ?? []).filter(
    (d) => d.changes > 0 && (!stack || d.stack === stack),
  );
  const total = envs.reduce((n, d) => n + d.changes, 0);
  const checked = latest ? ago(latest.checkedAt) : null;
  const checkNow = async (): Promise<void> => {
    await check.refetch();
    // The check also refreshed the cached AppView.drift.
    void qc.invalidateQueries({ queryKey: trpc.apps.list.queryKey() });
  };

  return (
    <span className="inline-flex items-center gap-1">
      {total > 0 ? (
        <Badge
          variant="outline"
          className="border-status-warning/40 text-tone-warn"
          title={envs
            .map(
              (d) => `${envLabel(d.environment)}: ${d.changes} change${d.changes === 1 ? '' : 's'}`,
            )
            .join(' · ')}
        >
          Drifted · {total}
        </Badge>
      ) : checked ? (
        <span className="text-muted-foreground mono-label">no drift</span>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground h-6 px-2 text-xs font-normal"
        title={checked ? `Checked ${checked}` : 'Never checked'}
        disabled={check.isFetching}
        onClick={() => void checkNow()}
      >
        <RefreshCwIcon className={cn('size-3', check.isFetching && 'animate-spin')} /> Check now
      </Button>
    </span>
  );
}
