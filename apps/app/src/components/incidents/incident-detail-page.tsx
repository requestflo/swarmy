import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeftIcon, RotateCcwIcon } from 'lucide-react';
import { Button, Card, CardContent, Separator, Skeleton, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { IncidentStatusChip, SeverityChip, formatDuration, relativeTime } from './incident-status';
import { IncidentTimeline } from './incident-timeline';
import { NoteComposer } from './note-composer';
import { ResolveIncidentDialog } from './resolve-incident-dialog';

/** One incident: the full timeline, notes composer and resolve/reopen. */
export function IncidentDetailPage({ incidentId }: { incidentId: string }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const incident = useQuery({
    ...trpc.incidents.get.queryOptions({ id: incidentId }),
    refetchInterval: 5_000,
  });
  const reopen = useMutation(
    trpc.incidents.reopen.mutationOptions({
      onSuccess: () => {
        toast.success('Incident reopened.');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const data = incident.data;

  return (
    <div className="mx-auto w-full max-w-[1100px] px-6 pt-8 lg:pb-20 xl:px-10">
      <Link
        to="/incidents"
        className="text-muted-foreground hover:text-foreground mb-4 inline-flex items-center gap-1.5 text-sm transition-colors"
      >
        <ArrowLeftIcon className="size-4" /> All incidents
      </Link>

      {incident.isLoading ? (
        <div className="grid gap-4">
          <Skeleton className="h-24 w-2/3" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : incident.isError ? (
        <Card className="card-pop border-0">
          <CardContent className="flex flex-col items-center gap-3 py-12">
            <p className="text-status-offline text-sm">{incident.error.message}</p>
            <Button variant="outline" onClick={() => void incident.refetch()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : data ? (
        <>
          <PageHeader
            eyebrow="Operations · Incident"
            title={
              data.status === 'open' ? (
                <>
                  {data.title} — <em>open</em>.
                </>
              ) : (
                <>
                  {data.title} — <em>resolved</em>.
                </>
              )
            }
            description={
              data.status === 'open'
                ? `Opened ${relativeTime(data.openedAt)} · ${formatDuration(data.durationSec)} and counting · ${data.eventCount} events.`
                : `Resolved ${data.resolvedAt ? relativeTime(data.resolvedAt) : ''} · ${formatDuration(data.durationSec)} start to finish · ${data.eventCount} events.`
            }
            actions={
              data.status === 'open' ? (
                <ResolveIncidentDialog incidentId={data.id} title={data.title} />
              ) : (
                <Button
                  variant="outline"
                  disabled={reopen.isPending}
                  onClick={() => reopen.mutate({ id: data.id })}
                >
                  <RotateCcwIcon className="size-4" />
                  {reopen.isPending ? 'Reopening…' : 'Reopen'}
                </Button>
              )
            }
          />

          <div className="mb-6 flex flex-wrap items-center gap-2">
            <IncidentStatusChip status={data.status} />
            <SeverityChip severity={data.severity} />
            {data.summary ? (
              <p className="text-muted-foreground w-full text-sm sm:w-auto">{data.summary}</p>
            ) : null}
          </div>

          <Card className="card-pop border-0">
            <CardContent className="px-0 py-6">
              <h2 className="mono-label text-muted-foreground mb-4 px-6">Timeline</h2>
              <IncidentTimeline events={data.events} />
              <Separator className="my-4" />
              <div className="px-6">
                <NoteComposer incidentId={data.id} />
              </div>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
