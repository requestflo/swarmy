import * as React from 'react';
import { getRouteApi } from '@tanstack/react-router';
import { CodeView, Say } from '@/components/calm';
import { ErrorState, SkeletonBody } from '@/components/states';
import { RowPage, plural } from '@/components/rowpage/row-page';
import { BackToStream, IncidentRoom } from '@/components/incidents/incident-room';
import { useMinWidth } from '@/lib/use-min-width';
import { activityCode } from './activity-code';
import { ActivityTimeline } from './activity-timeline';
import { NothingOpen } from './nothing-open';
import { useActivityFeed } from './use-activity-feed';

const route = getRouteApi('/_authed/activity');
const hhmm = (iso: string): string => new Date(iso).toTimeString().slice(0, 5);

/**
 * Activity › Stream: everything that happened, newest first, and the incident
 * room beside it on xl (`?incident=<id>`). Below xl a selected incident
 * replaces the stream, with a "← Stream" link back.
 */
export function ActivityPage(): React.JSX.Element {
  const search = route.useSearch();
  const xl = useMinWidth(1280);
  const feed = useActivityFeed();
  const { firing, openIncidents, items } = feed;
  const filter = search.filter ?? 'all';
  const newestOpen = [...openIncidents].sort((a, b) => b.openedAt.localeCompare(a.openedAt))[0];
  const selected = search.incident ?? (xl ? newestOpen?.id : undefined);
  const incident = openIncidents[0];
  const dayAgo = Date.now() - 24 * 3600_000;
  const recent = items.filter((i) => new Date(i.at).getTime() > dayAgo);
  const count = (k: string): number => recent.filter((i) => i.kind === k).length;

  const title = feed.isLoading ? (
    'What happened, newest first.'
  ) : incident ? (
    <>
      <Say tone="bad">{openIncidents.length === 1 ? 'An incident is open' : `${openIncidents.length} incidents are open`}</Say>.{' '}
      {firing.length ? <em>{plural(firing.length, 'alert')} firing.</em> : null}
    </>
  ) : firing[0] ? (
    <>
      Quiet since {hhmm(firing[0].firedAt)}. <Say tone="warn">{plural(firing.length, 'alert')} firing.</Say>
    </>
  ) : (
    <>
      All quiet. <em>Nothing needs you.</em>
    </>
  );
  const lede = feed.isLoading
    ? undefined
    : `${incident ? `${feed.words(incident.title)}. ` : ''}In the last 24 hours: ${plural(count('deploy'), 'deploy')}, ${plural(count('alert'), 'alert')}, ${plural(count('backup'), 'backup')} and ${plural(count('change'), 'other change')}.`;

  const code = <CodeView title="This stream as code" tabs={activityCode(feed.audit)} note="The audit log over REST, with an org API key. Alerts and incidents are read in the dashboard." />;
  const stream = feed.isLoading ? (
    <SkeletonBody variant="list" />
  ) : feed.error ? (
    <ErrorState title="Couldn’t load the stream." error={feed.error} retry={feed.refetch} />
  ) : (
    <ActivityTimeline items={items} filter={filter} selectedId={selected} />
  );

  if (!xl && search.incident) {
    return (
      <RowPage title={title} description={lede}>
        <IncidentRoom incidentId={search.incident} back={<BackToStream filter={search.filter} />} />
      </RowPage>
    );
  }
  return (
    <RowPage title={title} description={lede}>
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="min-w-0">{stream}</div>
        <div className="flex min-w-0 flex-col gap-5 xl:border-border xl:border-l xl:pl-6">
          {code}
          {!xl ? null : selected ? <IncidentRoom incidentId={selected} /> : feed.isLoading ? null : <NothingOpen />}
        </div>
      </div>
    </RowPage>
  );
}
