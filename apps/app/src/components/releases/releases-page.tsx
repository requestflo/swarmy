import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { RocketIcon } from 'lucide-react';
import type { ReleaseView } from '@swarmy/core';
import { Button, Card, CardContent, EmptyState, Skeleton } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { CanaryPanel } from './canary-panel';
import { ReleaseDetailCard } from './release-detail-card';
import { ReleasesFeed } from './releases-feed';
import { SafetyCard } from './safety-card';
import { StackFilter } from './stack-filter';

/** The Releases surface: org-wide deploy feed → per-stack history + safety. */
export function ReleasesPage(): React.JSX.Element {
  const trpc = useTRPC();
  const [stackName, setStackName] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<ReleaseView | null>(null);

  const overview = useQuery({ ...trpc.releases.overview.queryOptions(), refetchInterval: 5_000 });
  const releases = useQuery({
    ...trpc.releases.list.queryOptions({ stackName: stackName ?? undefined, limit: 50 }),
    refetchInterval: 5_000,
  });

  const rows = releases.data ?? [];
  const selectedRow = (selected && rows.find((r) => r.id === selected.id)) || selected;
  const deploying = overview.data?.deploying ?? 0;
  const failed = overview.data?.failed ?? 0;
  const total = overview.data?.total ?? 0;

  const hero =
    deploying > 0 ? (
      <>
        {deploying} deploy{deploying === 1 ? '' : 's'} <em>in flight</em>.
      </>
    ) : failed > 0 ? (
      <>
        {failed} release{failed === 1 ? '' : 's'} <em>failed</em>.
      </>
    ) : total > 0 ? (
      <>
        {total} release{total === 1 ? '' : 's'}, <em>rollback ready</em>.
      </>
    ) : (
      <>
        <em>Releases</em>.
      </>
    );

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Delivery · Releases"
        title={hero}
        description="Every deploy, snapshotted — health gates judge it, diffs explain it, rollback undoes it."
        actions={<StackFilter value={stackName} onChange={(v) => { setStackName(v); setSelected(null); }} />}
      />

      {releases.isLoading ? (
        <Card className="card-pop border-0">
          <CardContent className="grid gap-3 py-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-2/3" />
          </CardContent>
        </Card>
      ) : releases.isError ? (
        <Card className="card-pop border-0">
          <CardContent className="flex flex-col items-center gap-3 py-12">
            <p className="text-status-offline text-sm">{releases.error.message}</p>
            <Button variant="outline" onClick={() => void releases.refetch()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : rows.length === 0 ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<RocketIcon />}
            title={stackName ? `No releases for ${stackName} yet` : 'No releases yet'}
            description="Deploy a stack and every release lands here with its compose snapshot, health-gate verdict and one-click rollback."
          />
        </div>
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
          <Card className="card-pop border-0">
            <CardContent className="p-0">
              <ReleasesFeed
                releases={rows}
                selectedId={selectedRow?.id ?? null}
                onSelect={(r) => {
                  setSelected(r);
                  setStackName(r.stackName);
                }}
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
            <CanaryPanel stackName={stackName} />
            {stackName ? <SafetyCard stackName={stackName} /> : null}
          </div>
        </div>
      )}
    </div>
  );
}
