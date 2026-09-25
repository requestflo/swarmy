import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@swarmy/ui';
import { CalmRow, CodeView, NextAction, RowList, Say, Section } from '@/components/calm';
import { ErrorState, SkeletonBody } from '@/components/states';
import { RowPage, plural } from '@/components/rowpage/row-page';
import { AckButton } from '@/components/alerts/ack-button';
import { activityCode } from './activity-code';
import { ActivityTimeline } from './activity-timeline';
import { useActivityFeed } from './use-activity-feed';

const hhmm = (iso: string): string => new Date(iso).toTimeString().slice(0, 5);

/** Activity → Timeline: everything that happened, newest first, and the one thing worth doing. */
export function ActivityPage(): React.JSX.Element {
  const feed = useActivityFeed();
  const { firing, openIncidents, items } = feed;
  const incident = openIncidents[0];
  const alert = firing[0];
  const dayAgo = Date.now() - 24 * 3600_000;
  const recent = items.filter((i) => new Date(i.at).getTime() > dayAgo);
  const deploys = recent.filter((i) => i.kind === 'deploy').length;

  const title = feed.isLoading ? (
    'What happened, newest first.'
  ) : incident ? (
    <>
      <Say tone="bad">{incident.title}</Say> is open.{' '}
      {firing.length ? <em>{plural(firing.length, 'alert')} firing.</em> : null}
    </>
  ) : alert ? (
    <>
      Quiet since {hhmm(alert.firedAt)}. <Say tone="warn">{plural(firing.length, 'alert')} firing.</Say>
    </>
  ) : (
    <>
      All quiet. <em>Nothing needs you.</em>
    </>
  );
  const lede = feed.isLoading
    ? undefined
    : `In the last 24 hours: ${plural(deploys, 'deploy')}, ${plural(recent.filter((i) => i.kind === 'alert').length, 'alert')} and ${plural(recent.filter((i) => i.kind === 'change').length, 'other change')}.`;

  const aside = (
    <>
      <CodeView title="This timeline as code" tabs={activityCode(feed.audit)} note="The audit log over REST, with an org API key. Alerts and incidents are read in the dashboard." />
      <Section title="Right now" count={feed.isLoading ? undefined : plural(firing.length + openIncidents.length, 'open item')} flush>
        <RowList label="Open right now">
          {openIncidents.map((i) => (
            <CalmRow key={i.id} tone="bad" name={i.title} word="Open" to="/incidents/$incidentId" params={{ incidentId: i.id }} tech={i.severity} />
          ))}
          {firing.map((e) => (
            <CalmRow key={e.id} tone={e.severity === 'critical' ? 'bad' : 'warn'} name={e.ruleName ?? e.signal} sub={e.resource} word="Firing" to="/alerts" tech={e.signal} />
          ))}
          {!feed.isLoading && firing.length + openIncidents.length === 0 ? (
            <p className="text-muted-foreground py-3 text-sm">Nothing is firing and no incident is open.</p>
          ) : null}
        </RowList>
      </Section>
    </>
  );

  return (
    <RowPage title={title} description={lede} aside={aside}>
      {incident ? (
        <NextAction
          tone="bad"
          title={`${incident.title} needs a look.`}
          tech={`incident ${incident.id} · ${incident.severity} · ${incident.eventCount} events`}
          actions={
            <Button asChild className="pointer-coarse:min-h-11">
              <Link to="/incidents/$incidentId" params={{ incidentId: incident.id }}>Open the incident</Link>
            </Button>
          }
        >
          Every step so far is on its timeline. Add a note or mark it resolved there.
        </NextAction>
      ) : alert ? (
        <NextAction
          title={alert.message}
          since={hhmm(alert.firedAt)}
          tech={`${alert.signal} · ${alert.resource} · ${alert.severity}`}
          actions={<AckButton id={alert.id} label="Acknowledge" primary size="default" />}
          hint={<Link to="/alerts" className="hover:text-foreground underline-offset-2 hover:underline">See all alerts</Link>}
        >
          Acknowledging says someone has it. It stops the reminders; the rule keeps watching.
        </NextAction>
      ) : null}
      {feed.isLoading ? (
        <SkeletonBody variant="list" />
      ) : feed.error ? (
        <ErrorState title="Couldn’t load the timeline." error={feed.error} retry={feed.refetch} />
      ) : (
        <ActivityTimeline items={items} />
      )}
    </RowPage>
  );
}
