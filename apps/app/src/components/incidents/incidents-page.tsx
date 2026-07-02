import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { SirenIcon } from 'lucide-react';
import type { IncidentView } from '@swarmy/core';
import { Button, Card, CardContent, EmptyState, Skeleton } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { IncidentRow } from './incident-row';

function IncidentList({ incidents }: { incidents: IncidentView[] }): React.JSX.Element {
  return (
    <Card className="card-pop border-0">
      <CardContent className="p-0">
        {incidents.map((incident) => (
          <IncidentRow key={incident.id} incident={incident} />
        ))}
      </CardContent>
    </Card>
  );
}

/**
 * The Incidents surface: open incidents first (they need you), then the past
 * ones — each row links into the full timeline.
 */
export function IncidentsPage(): React.JSX.Element {
  const trpc = useTRPC();
  const overview = useQuery({ ...trpc.incidents.overview.queryOptions(), refetchInterval: 5_000 });
  const open = useQuery({
    ...trpc.incidents.list.queryOptions({ status: 'open', limit: 50 }),
    refetchInterval: 5_000,
  });
  const past = useQuery({
    ...trpc.incidents.list.queryOptions({ status: 'resolved', limit: 50 }),
    refetchInterval: 15_000,
  });

  const openRows = open.data ?? [];
  const pastRows = past.data ?? [];
  const openCount = overview.data?.open ?? openRows.length;

  const hero =
    openCount > 0 ? (
      <>
        {openCount} incident{openCount === 1 ? '' : 's'} <em>open</em>.
      </>
    ) : (
      <>
        All <em>quiet</em>.
      </>
    );

  const loading = open.isLoading || past.isLoading;
  const error = open.isError ? open.error : past.isError ? past.error : null;

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Operations · Incidents"
        title={hero}
        description="When something breaks, the whole story lands here — what fired, what swarmy did, when it resolved."
      />

      {loading ? (
        <Card className="card-pop border-0">
          <CardContent className="grid gap-3 py-6">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-2/3" />
          </CardContent>
        </Card>
      ) : error ? (
        <Card className="card-pop border-0">
          <CardContent className="flex flex-col items-center gap-3 py-12">
            <p className="text-status-offline text-sm">{error.message}</p>
            <Button
              variant="outline"
              onClick={() => {
                void open.refetch();
                void past.refetch();
              }}
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : openRows.length === 0 && pastRows.length === 0 ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<SirenIcon />}
            title="No incidents — nothing has broken yet"
            description="When an alert turns critical, a database fails over or a deploy fails its health gate, swarmy opens an incident and records every step here."
          />
        </div>
      ) : (
        <div className="grid gap-8">
          {openRows.length > 0 ? (
            <section>
              <h2 className="mono-label text-status-offline mb-3">
                Open — needs you ({openRows.length})
              </h2>
              <IncidentList incidents={openRows} />
            </section>
          ) : null}
          {pastRows.length > 0 ? (
            <section>
              <h2 className="mono-label text-muted-foreground mb-3">
                Past incidents ({pastRows.length}
                {overview.data ? ` · ${overview.data.resolved7d} resolved this week` : ''})
              </h2>
              <IncidentList incidents={pastRows} />
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
