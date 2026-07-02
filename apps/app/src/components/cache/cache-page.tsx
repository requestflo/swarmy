import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ZapIcon } from 'lucide-react';
import { Button, EmptyState } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { CacheClusterCard } from './cache-cluster-card';
import { CacheClusterPanel } from './cache-cluster-panel';
import { CreateCacheDialog } from './create-cache-dialog';

/**
 * Data → Caches: every managed Valkey/Redis cluster in the org, the create
 * wizard, and the click-through detail panel.
 */
export function CachePage(): React.JSX.Element {
  const trpc = useTRPC();
  const [selected, setSelected] = React.useState<{ stack: string; name: string } | null>(null);

  const clusters = useQuery({
    ...trpc.cache.list.queryOptions(),
    refetchInterval: 5_000,
  });

  const rows = clusters.data ?? [];
  const healthy = rows.filter((c) => c.primary.status === 'running').length;

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Data"
        title={
          rows.length === 0 ? (
            <>
              Caches, <em>managed</em>.
            </>
          ) : (
            <>
              {healthy} of {rows.length} caches <em>healthy</em>.
            </>
          )
        }
        description="Managed Redis and Valkey on your own swarm — HA topologies, memory limits, app attachment. Private by default, passwords live in Docker secrets."
        actions={<CreateCacheDialog />}
      />

      {clusters.isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card-pop space-y-3 p-5">
              <div className="shimmer-line h-9 rounded-lg" />
              <div className="shimmer-line h-4 w-2/3 rounded" />
              <div className="shimmer-line h-10 rounded-lg" />
            </div>
          ))}
        </div>
      ) : clusters.isError ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<ZapIcon />}
            title="Couldn't load caches"
            description={clusters.error.message}
            action={
              <Button variant="outline" onClick={() => void clusters.refetch()}>
                Retry
              </Button>
            }
          />
        </div>
      ) : rows.length === 0 ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<ZapIcon />}
            title="No caches yet — create one."
            description="One click provisions Valkey or Redis on your swarm: password in a Docker secret, no public ports, replicas and sentinel failover when you need them."
            action={<CreateCacheDialog variant="outline" />}
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((c) => (
            <CacheClusterCard
              key={`${c.stack}/${c.name}`}
              view={c}
              onOpen={() => setSelected({ stack: c.stack, name: c.name })}
            />
          ))}
        </div>
      )}

      <CacheClusterPanel
        stack={selected?.stack ?? null}
        cluster={selected?.name ?? null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      />
    </div>
  );
}
