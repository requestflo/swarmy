import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { SnapshotRows } from './snapshot-rows';

/** Estate-wide recent snapshots — every stack, newest first. Live (5s poll). */
export function EstateSnapshotsCard(): React.JSX.Element {
  const trpc = useTRPC();
  const snapshots = useQuery({
    ...trpc.backups.listSnapshots.queryOptions({}),
    refetchInterval: 5_000,
  });
  const rows = snapshots.data ?? [];

  return (
    <Card className="card-pop border-0">
      <CardContent className="p-0">
        <div className="flex items-center justify-between gap-3 px-6 py-4">
          <span className="mono-label">Recent snapshots · estate-wide</span>
          <span className="text-muted-foreground mono-label">{rows.length} in catalog</span>
        </div>
        <SnapshotRows
          rows={rows}
          emptyTitle="No snapshots yet."
          emptyDescription="Open a stack's Backups tab and run its first backup — restore points land here the moment they finish."
        />
      </CardContent>
    </Card>
  );
}
