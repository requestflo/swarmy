import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeftIcon, RotateCcwIcon } from 'lucide-react';
import { Button, toast } from '@swarmy/ui';
import type { IncidentDetailView } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { Section } from '@/components/calm';
import { ErrorState, SkeletonBody } from '@/components/states';
import { formatDuration, relativeTime } from './incident-status';
import { IncidentAside } from './incident-aside';
import { IncidentPublicCard } from './incident-public-card';
import { IncidentTimeline } from './incident-timeline';
import { NoteComposer } from './note-composer';
import { ResolveIncidentDialog } from './resolve-incident-dialog';
import { IncidentChart } from './incident-chart';
import { BestGuessCard, BlastRadiusCard } from './incident-diagnosis';
import { incidentMetric } from './incident-scope';
import { plainWords } from './incident-words';
import { useIncidentEvidence } from './use-incident-evidence';
import { useIncidentScope } from './use-incident-scope';

/**
 * The incident room beside the Stream: a mono eyebrow, the title, resolve /
 * reopen, the metric chart with its deploy markers, swarmy's best guess, the
 * blast radius, what the public status page shows and the timeline with the
 * note composer. `back` renders the "← Stream" link below xl.
 */
export function IncidentRoom({ incidentId, back }: { incidentId: string; back?: React.ReactNode }): React.JSX.Element {
  const trpc = useTRPC();
  const incident = useQuery({ ...trpc.incidents.get.queryOptions({ id: incidentId }), refetchInterval: 5_000 });
  const d = incident.data;
  if (incident.isLoading) return <div className="flex flex-col gap-4">{back}<SkeletonBody variant="list" /></div>;
  if (incident.isError || !d) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <ErrorState title="Couldn’t load this incident." error={incident.error} retry={() => void incident.refetch()} />
      </div>
    );
  }
  return <RoomBody incident={d} back={back} />;
}

function RoomBody({ incident: d, back }: { incident: IncidentDetailView; back?: React.ReactNode }): React.JSX.Element {
  const qc = useQueryClient();
  const trpc = useTRPC();
  const reopen = useMutation(
    trpc.incidents.reopen.mutationOptions({
      onSuccess: () => {
        toast.success('Incident reopened.');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const { scope, ctx, inventory, releases } = useIncidentScope(d);
  const { guess, blast } = useIncidentEvidence(d, scope, inventory, releases);
  const words = (t: string): string => plainWords(t, ctx);
  const open = d.status === 'open';
  const putBackOffered = open && guess?.cause === 'deploy' && guess.putBack !== null;
  const eyebrow = [d.id, d.status, open ? formatDuration(d.durationSec) : `took ${formatDuration(d.durationSec)}`, d.severity].join(' · ');
  return (
    <article aria-label={`Incident: ${d.title}`} className="@container flex min-w-0 flex-col gap-5">
      {back}
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className={open ? 'text-tone-bad font-mono text-[11.5px] tracking-wide' : 'text-muted-foreground font-mono text-[11.5px] tracking-wide'}>{eyebrow}</span>
          <h2 className="say text-[1.6rem] leading-tight sm:text-[1.85rem]">{words(d.title)}</h2>
          <p className="lede text-[14px]">
            {(d.summary && words(d.summary)) ??
              (open
                ? `Opened ${relativeTime(d.openedAt)}. ${d.eventCount} steps on the timeline so far.`
                : `Resolved ${d.resolvedAt ? relativeTime(d.resolvedAt) : ''}. ${d.eventCount} steps from start to finish.`)}
          </p>
        </div>
        {open ? (
          <ResolveIncidentDialog incidentId={d.id} title={words(d.title)} quiet={putBackOffered} />
        ) : (
          <Button variant="outline" disabled={reopen.isPending} onClick={() => reopen.mutate({ id: d.id })} className="pointer-coarse:min-h-11">
            <RotateCcwIcon className="size-4" /> {reopen.isPending ? 'Reopening…' : 'Reopen'}
          </Button>
        )}
      </header>
      <IncidentChart app={scope.app} metric={incidentMetric(scope, d.title)} releases={releases} address={blast?.address ?? null} />
      <div className="grid gap-5 @xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <BestGuessCard guess={guess} open={open} />
        <BlastRadiusCard app={scope.app} part={scope.part} blast={blast} />
      </div>
      <IncidentPublicCard incident={d} />
      <Section title="Timeline" count={`${d.events.length} steps`} hint="oldest first">
        <IncidentTimeline events={d.events} words={words} />
        <div className="border-border border-t pt-4">
          <NoteComposer incidentId={d.id} />
        </div>
      </Section>
      <IncidentAside incident={d} />
    </article>
  );
}

/** The "← Stream" link shown above the room below xl. */
export function BackToStream({ filter }: { filter?: string }): React.JSX.Element {
  return (
    <Link
      to="/activity"
      search={filter ? { filter: filter as never } : {}}
      className="text-muted-foreground hover:text-foreground inline-flex min-h-11 w-fit items-center gap-1.5 text-sm font-semibold"
    >
      <ArrowLeftIcon className="size-4" /> Stream
    </Link>
  );
}
