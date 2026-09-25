import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Button } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CodeView, NextAction, RowList, Say, Section } from '@/components/calm';
import { ErrorState, SkeletonBody } from '@/components/states';
import { RowPage, plural } from '@/components/rowpage/row-page';
import { formatDuration } from './incident-status';
import { IncidentRow } from './incident-row';

/** Activity → Incidents: open ones first (they need you), then the past, each linking to its timeline. */
export function IncidentsPage(): React.JSX.Element {
  const trpc = useTRPC();
  const overview = useQuery({ ...trpc.incidents.overview.queryOptions(), refetchInterval: 5_000 });
  const open = useQuery({ ...trpc.incidents.list.queryOptions({ status: 'open', limit: 50 }), refetchInterval: 5_000 });
  const past = useQuery({ ...trpc.incidents.list.queryOptions({ status: 'resolved', limit: 50 }), refetchInterval: 15_000 });
  const openRows = open.data ?? [];
  const pastRows = past.data ?? [];
  const o = overview.data;
  const first = openRows[0];
  const loading = open.isLoading || past.isLoading;
  const error = open.error ?? past.error;

  const title = !o ? (
    'Incidents.'
  ) : o.open > 0 ? (
    <>
      <Say tone="bad">{o.open === 1 ? 'An incident is open.' : `${o.open} incidents are open.`}</Say>{' '}
      <em>{plural(o.resolved7d, 'fixed', 'fixed')} this week.</em>
    </>
  ) : (
    <>
      Nothing is broken. <em>{plural(o.resolved7d, 'incident')} fixed this week.</em>
    </>
  );

  return (
    <RowPage
      title={title}
      description="When something breaks, the whole story lands here: what fired, what swarmy did, and when it was fixed."
    >
      <CodeView title="Incidents as data" tabs={[{ label: 'JSON', code: JSON.stringify({ open: openRows, resolved: pastRows.slice(0, 5) }, null, 2) }]} source="readonly" />
      {first ? (
        <NextAction
          tone="bad"
          title={`${first.title} needs someone.`}
          since={formatDuration(first.durationSec)}
          tech={`${first.id} · ${first.severity} · ${first.eventCount} events`}
          actions={
            <Button asChild className="pointer-coarse:min-h-11">
              <Link to="/incidents/$incidentId" params={{ incidentId: first.id }}>Open the timeline</Link>
            </Button>
          }
        >
          Add a note so the team knows who has it, then mark it resolved when it’s fixed.
        </NextAction>
      ) : null}
      {loading ? (
        <SkeletonBody variant="list" />
      ) : error ? (
        <ErrorState title="Couldn’t load incidents." error={error} retry={() => { void open.refetch(); void past.refetch(); }} />
      ) : (
        <>
          {openRows.length > 0 ? (
            <Section title="Open" count={openRows.length} flush>
              <RowList label="Open incidents">{openRows.map((i) => <IncidentRow key={i.id} incident={i} />)}</RowList>
            </Section>
          ) : null}
          <Section title="Past incidents" count={pastRows.length || undefined} flush>
            <RowList label="Past incidents">
              {pastRows.length === 0 ? (
                <p className="text-muted-foreground py-4 text-sm">None yet. When an alert turns critical or a deploy fails its health check, swarmy opens one and records every step.</p>
              ) : (
                pastRows.map((i) => <IncidentRow key={i.id} incident={i} />)
              )}
            </RowList>
          </Section>
        </>
      )}
    </RowPage>
  );
}
