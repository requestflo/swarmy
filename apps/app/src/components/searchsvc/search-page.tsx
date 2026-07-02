import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { SearchIcon } from 'lucide-react';
import { Button, EmptyState } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { CreateSearchDialog } from './create-search-dialog';
import { SearchInstanceCard } from './search-instance-card';
import { SearchInstancePanel } from './search-instance-panel';

/**
 * Data → Search: every managed Meilisearch/Typesense instance in the org, the
 * create wizard, and the click-through detail panel.
 */
export function SearchPage(): React.JSX.Element {
  const trpc = useTRPC();
  const [selected, setSelected] = React.useState<{ stack: string; name: string } | null>(null);

  const instances = useQuery({
    ...trpc.search.list.queryOptions(),
    refetchInterval: 5_000,
  });

  const rows = instances.data ?? [];
  const healthy = rows.filter((i) => i.status === 'running' && i.running >= i.desired).length;

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Data"
        title={
          rows.length === 0 ? (
            <>
              Search, <em>managed</em>.
            </>
          ) : (
            <>
              {healthy} of {rows.length} engines <em>healthy</em>.
            </>
          )
        }
        description="Managed Meilisearch and Typesense on your own swarm — one click to provision, master key in a Docker secret, wired into your apps. Private by default."
        actions={<CreateSearchDialog />}
      />

      {instances.isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card-pop space-y-3 p-5">
              <div className="shimmer-line h-9 rounded-lg" />
              <div className="shimmer-line h-4 w-2/3 rounded" />
              <div className="shimmer-line h-10 rounded-lg" />
            </div>
          ))}
        </div>
      ) : instances.isError ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<SearchIcon />}
            title="Couldn't load search instances"
            description={instances.error.message}
            action={
              <Button variant="outline" onClick={() => void instances.refetch()}>
                Retry
              </Button>
            }
          />
        </div>
      ) : rows.length === 0 ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<SearchIcon />}
            title="No search engines yet — create one."
            description="Managed search gives your apps instant, typo-tolerant search without running servers yourself: swarmy provisions Meilisearch or Typesense on your swarm, keeps the master key in a Docker secret, and injects the connection into any app you attach."
            action={<CreateSearchDialog variant="outline" />}
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((i) => (
            <SearchInstanceCard
              key={`${i.stack}/${i.name}`}
              view={i}
              onOpen={() => setSelected({ stack: i.stack, name: i.name })}
            />
          ))}
        </div>
      )}

      <SearchInstancePanel
        stack={selected?.stack ?? null}
        name={selected?.name ?? null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      />
    </div>
  );
}
