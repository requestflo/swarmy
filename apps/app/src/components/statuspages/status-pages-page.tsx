import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon, RadioTowerIcon } from 'lucide-react';
import { Button, Card, CardContent, EmptyState, Skeleton } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { StatusPageDialog } from './status-page-dialog';
import { StatusPageRow } from './status-page-row';

/**
 * The Status pages settings surface: your public pages in one card — create,
 * pick components, preview at `/s/<slug>`, flip live/dark, edit, delete.
 */
export function StatusPagesPage(): React.JSX.Element {
  const trpc = useTRPC();
  const overview = useQuery({ ...trpc.statusPages.overview.queryOptions(), refetchInterval: 15_000 });
  const pages = useQuery({ ...trpc.statusPages.list.queryOptions(), refetchInterval: 15_000 });

  const rows = pages.data ?? [];
  const liveCount = overview.data?.enabled ?? rows.filter((p) => p.enabled).length;

  const hero =
    rows.length === 0 ? (
      <>
        Your status, <em>public</em>.
      </>
    ) : (
      <>
        {liveCount} page{liveCount === 1 ? '' : 's'} <em>live</em>.
      </>
    );

  const createTrigger = (
    <Button>
      <PlusIcon className="size-4" /> New status page
    </Button>
  );

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Operations · Status pages"
        title={hero}
        description="A public page your users can trust — live component status, 90-day uptime bars and incident history, at /s/<slug> or your own domain."
        actions={rows.length > 0 ? <StatusPageDialog trigger={createTrigger} /> : undefined}
      />

      {pages.isLoading ? (
        <Card className="card-pop border-0">
          <CardContent className="grid gap-3 py-6">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-2/3" />
          </CardContent>
        </Card>
      ) : pages.isError ? (
        <Card className="card-pop border-0">
          <CardContent className="flex flex-col items-center gap-3 py-12">
            <p className="text-status-offline text-sm">{pages.error.message}</p>
            <Button variant="outline" onClick={() => void pages.refetch()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : rows.length === 0 ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<RadioTowerIcon />}
            title="No status pages yet"
            description="Create one, pick the components your users care about, and share the public link. swarmy keeps the status, uptime and incident history current."
            action={<StatusPageDialog trigger={createTrigger} />}
          />
        </div>
      ) : (
        <>
          <Card className="card-pop border-0">
            <CardContent className="p-0">
              {rows.map((page) => (
                <StatusPageRow key={page.id} page={page} />
              ))}
            </CardContent>
          </Card>
          {overview.data ? (
            <p className="text-muted-foreground mt-3 text-xs">
              <span className="mono-data">{overview.data.components}</span> components watched ·{' '}
              <span className="mono-data">{overview.data.samples24h.toLocaleString()}</span> uptime
              samples in the last 24h.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
