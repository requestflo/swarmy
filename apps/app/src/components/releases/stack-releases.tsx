import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { RocketIcon } from 'lucide-react';
import type { ReleaseView } from '@swarmy/core';
import { Button, Card, CardContent, EmptyState, Skeleton } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CanaryPanel } from './canary-panel';
import { ReleaseDetailCard } from './release-detail-card';
import { ReleaseStats } from './release-stats';
import { ReleasesFeed } from './releases-feed';
import { SafetyCard } from './safety-card';

interface StackReleasesProps {
  stack: string;
}

/**
 * The Releases tab of the stack workspace: this stack's deploy timeline,
 * the selected release's diff + rollback, the canary rollout and the
 * deploy-safety settings — all scoped by the route param, no picker.
 */
export function StackReleases({ stack }: StackReleasesProps): React.JSX.Element {
  const trpc = useTRPC();
  const [selected, setSelected] = React.useState<ReleaseView | null>(null);

  const overview = useQuery({
    ...trpc.releases.overview.queryOptions({ stackName: stack }),
    refetchInterval: 5_000,
  });
  const releases = useQuery({
    ...trpc.releases.list.queryOptions({ stackName: stack, limit: 50 }),
    refetchInterval: 5_000,
  });

  const rows = releases.data ?? [];
  const selectedRow = (selected && rows.find((r) => r.id === selected.id)) || selected;

  if (releases.isLoading) {
    return (
      <Card className="card-pop border-0">
        <CardContent className="grid gap-3 py-6">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-2/3" />
        </CardContent>
      </Card>
    );
  }

  if (releases.isError) {
    return (
      <Card className="card-pop border-0">
        <CardContent className="flex flex-col items-center gap-3 py-12">
          <p className="text-status-offline text-sm">{releases.error.message}</p>
          <Button variant="outline" onClick={() => void releases.refetch()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="grid gap-6">
        <div className="card-pop p-2">
          <EmptyState
            icon={<RocketIcon />}
            title={`No releases for ${stack} yet`}
            description="Deploy this stack and every release lands here with its compose snapshot, health-gate verdict and one-click rollback."
          />
        </div>
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <CanaryPanel stack={stack} />
          <SafetyCard stackName={stack} />
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      {overview.data ? <ReleaseStats overview={overview.data} /> : null}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <Card className="card-pop border-0">
          <CardContent className="p-0">
            <ReleasesFeed
              releases={rows}
              selectedId={selectedRow?.id ?? null}
              onSelect={setSelected}
            />
          </CardContent>
        </Card>

        <div className="grid gap-6">
          {selectedRow ? (
            <ReleaseDetailCard release={selectedRow} />
          ) : (
            <Card className="card-pop border-0">
              <CardContent className="text-muted-foreground px-6 py-10 text-center text-sm">
                Select a release to see its images, compose diff and rollback.
              </CardContent>
            </Card>
          )}
          <CanaryPanel stack={stack} />
          <SafetyCard stackName={stack} />
        </div>
      </div>
    </div>
  );
}
