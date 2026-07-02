import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ReleaseView } from '@swarmy/core';
import { Card, CardContent, CardHeader, CardTitle, Skeleton } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { ComposeDiff } from './compose-diff';
import { ReleaseStatusChip, relativeTime } from './release-status';
import { RollbackDialog } from './rollback-dialog';

/**
 * Selected release: what shipped (images, actor, gate verdict), the compose
 * diff against the previous deploy, and the rollback action.
 */
export function ReleaseDetailCard({ release }: { release: ReleaseView }): React.JSX.Element {
  const trpc = useTRPC();
  const detail = useQuery({
    ...trpc.releases.get.queryOptions({ id: release.id }),
    refetchInterval: 10_000,
  });

  return (
    <Card className="card-pop border-0">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
        <div className="flex items-center gap-3">
          <CardTitle className="text-base">{release.stackName}</CardTitle>
          <ReleaseStatusChip status={release.status} />
        </div>
        <RollbackDialog release={release} />
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <span>
            by <span className="text-foreground font-medium">{release.actor ?? 'system'}</span>
          </span>
          <span className="mono-label">{relativeTime(release.createdAt)}</span>
          {release.healthGate ? (
            <span className="mono-label">
              gate {release.healthGate.windowSec}s
              {release.healthGate.autoRollback ? ' · auto-rollback' : ''}
            </span>
          ) : (
            <span className="mono-label">no health gate</span>
          )}
        </div>

        {release.notes ? (
          <p className="bg-accent text-foreground rounded-xl px-4 py-2 text-xs">{release.notes}</p>
        ) : null}

        <div>
          <p className="mono-label text-muted-foreground mb-1.5">Images</p>
          <div className="grid gap-1">
            {release.images.map((img) => (
              <p key={img.name} className="font-mono text-xs">
                <span className="text-muted-foreground">{img.name}</span> → {img.image}
              </p>
            ))}
            {release.images.length === 0 ? (
              <p className="text-muted-foreground text-xs">No image snapshot recorded.</p>
            ) : null}
          </div>
        </div>

        <div>
          <p className="mono-label text-muted-foreground mb-1.5">
            Compose diff{detail.data?.previousId ? ' vs previous release' : ' (first release)'}
          </p>
          {detail.isLoading ? (
            <div className="grid gap-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-4 w-3/5" />
            </div>
          ) : detail.isError ? (
            <p className="text-status-offline text-xs">{detail.error.message}</p>
          ) : detail.data ? (
            <ComposeDiff diff={detail.data.diff} />
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
