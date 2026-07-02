import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { BoxIcon } from 'lucide-react';
import { Button, EmptyState } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { CreateVectorDialog } from './create-vector-dialog';
import { PgvectorCard } from './pgvector-card';
import { VectorInstanceCard } from './vector-instance-card';

/**
 * Data → Vector: managed qdrant instances + the pgvector enablement card for
 * existing managed Postgres clusters.
 */
export function VectorPage(): React.JSX.Element {
  const trpc = useTRPC();
  const instances = useQuery({ ...trpc.vector.list.queryOptions(), refetchInterval: 5_000 });
  const rows = instances.data ?? [];
  const healthy = rows.filter((v) => v.status === 'running').length;

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Data"
        title={
          rows.length === 0 ? (
            <>
              Vectors, <em>managed</em>.
            </>
          ) : (
            <>
              {healthy} of {rows.length} stores <em>healthy</em>.
            </>
          )
        }
        description="Qdrant on your own swarm — one click, API key in a Docker secret, no public ports. Or flip pgvector on inside a managed Postgres you already run."
        actions={<CreateVectorDialog />}
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
            icon={<BoxIcon />}
            title="Couldn't load vector stores"
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
            icon={<BoxIcon />}
            title="No vector stores yet — create one."
            description="One click provisions Qdrant on your swarm: private-only, key in a Docker secret, volume-backed storage. Attach an app and it gets QDRANT_URL automatically."
            action={<CreateVectorDialog variant="outline" />}
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((v) => (
            <VectorInstanceCard key={`${v.stack}/${v.name}`} view={v} />
          ))}
        </div>
      )}

      <div className="mt-6">
        <PgvectorCard />
      </div>
    </div>
  );
}
