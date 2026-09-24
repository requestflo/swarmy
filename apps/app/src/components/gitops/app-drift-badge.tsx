import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { envLabel } from './plan-status';

/** "Drifted" when live no longer matches the last applied commit (someone changed it by hand). */
export function AppDriftBadge({ repoId }: { repoId: string }): React.JSX.Element | null {
  const trpc = useTRPC();
  const drift = useQuery({ ...trpc.apps.drift.queryOptions({ repoId }), staleTime: 60_000 });
  const drifted = (drift.data ?? []).filter((d) => d.changes > 0);
  if (drifted.length === 0) return null;
  const total = drifted.reduce((n, d) => n + d.changes, 0);
  return (
    <Badge
      variant="outline"
      className="border-status-warning/40 text-status-warning"
      title={drifted
        .map((d) => `${envLabel(d.environment)}: ${d.changes} change${d.changes === 1 ? '' : 's'}`)
        .join(' · ')}
    >
      Drifted · {total}
    </Badge>
  );
}
