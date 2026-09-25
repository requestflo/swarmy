import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcwIcon } from 'lucide-react';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CalmPage, NextAction, Say, SayHeader, Section, Tech } from '@/components/calm';
import { ErrorState, SkeletonBody } from '@/components/states';
import { formatDuration, relativeTime } from './incident-status';
import { IncidentAside } from './incident-aside';
import { IncidentTimeline } from './incident-timeline';
import { NoteComposer } from './note-composer';
import { ResolveIncidentDialog } from './resolve-incident-dialog';

/** One incident: what happened, step by step; add a note; resolve or reopen. */
export function IncidentDetailPage({ incidentId }: { incidentId: string }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const incident = useQuery({ ...trpc.incidents.get.queryOptions({ id: incidentId }), refetchInterval: 5_000 });
  const reopen = useMutation(
    trpc.incidents.reopen.mutationOptions({
      onSuccess: () => {
        toast.success('Incident reopened.');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const d = incident.data;
  const crumbs = [{ label: 'Activity', to: '/activity' }, { label: 'Incidents', to: '/incidents' }, { label: d?.title ?? 'Incident' }];
  const actions =
    d && d.status === 'resolved' ? (
      <Button variant="outline" size="sm" disabled={reopen.isPending} onClick={() => reopen.mutate({ id: d.id })}>
        <RotateCcwIcon className="size-4" /> {reopen.isPending ? 'Reopening…' : 'Reopen'}
      </Button>
    ) : undefined;

  return (
    <CalmPage
      crumbs={crumbs}
      actions={actions}
      aside={d ? <IncidentAside incident={d} /> : undefined}
    >
      {incident.isLoading ? (
        <SkeletonBody variant="list" />
      ) : incident.isError ? (
        <ErrorState title="Couldn’t load this incident." error={incident.error} retry={() => void incident.refetch()} />
      ) : d ? (
        <>
          <SayHeader
            eyebrow={`${d.severity} incident`}
            title={
              d.status === 'open' ? (
                <>
                  {d.title}. <Say tone="bad">Open {formatDuration(d.durationSec)}.</Say>
                </>
              ) : (
                <>
                  {d.title}. <em>Fixed in {formatDuration(d.durationSec)}.</em>
                </>
              )
            }
            lede={
              d.summary ??
              (d.status === 'open'
                ? `Opened ${relativeTime(d.openedAt)}. ${d.eventCount} steps on the timeline so far.`
                : `Resolved ${d.resolvedAt ? relativeTime(d.resolvedAt) : ''}. ${d.eventCount} steps from start to finish.`)
            }
          />
          <Tech>{`${d.id} · ${d.severity} · opened ${d.openedAt}${d.resolvedAt ? ` · resolved ${d.resolvedAt}` : ''}`}</Tech>
          {d.status === 'open' ? (
            <NextAction title="Mark it resolved once it’s fixed." actions={<ResolveIncidentDialog incidentId={d.id} title={d.title} />} tone="bad">
              That writes a last step on the timeline. You can reopen it if it flares up again.
            </NextAction>
          ) : null}
          <Section title="What happened" count={`${d.events.length} steps`} hint="oldest first">
            <IncidentTimeline events={d.events} />
            <div className="border-border border-t pt-4">
              <NoteComposer incidentId={d.id} />
            </div>
          </Section>
        </>
      ) : null}
    </CalmPage>
  );
}
