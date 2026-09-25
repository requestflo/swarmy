import * as React from 'react';
import type { IncidentView } from '@swarmy/core';
import { CalmRow } from '@/components/calm';
import { stackFromIncidentTitle, useServiceStackMap } from '@/components/alerts/use-service-stack-map';
import { formatDuration, relativeTime } from './incident-status';

/** One incident as a quiet row linking to its timeline. */
export function IncidentRow({ incident }: { incident: IncidentView }): React.JSX.Element {
  const stackMap = useServiceStackMap();
  const app = stackFromIncidentTitle(incident.title, stackMap);
  const open = incident.status === 'open';
  const when = open
    ? `opened ${relativeTime(incident.openedAt)} · ${formatDuration(incident.durationSec)} so far`
    : `fixed ${incident.resolvedAt ? relativeTime(incident.resolvedAt) : ''} · took ${formatDuration(incident.durationSec)}`;
  return (
    <CalmRow
      tone={open ? (incident.severity === 'minor' ? 'warn' : 'bad') : 'ok'}
      name={incident.title}
      sub={app ? `app ${app}` : `${incident.eventCount} steps`}
      say={incident.summary ?? when}
      tech={`${incident.id} · ${incident.severity} · ${incident.eventCount} events`}
      word={open ? 'Open' : 'Resolved'}
      to="/incidents/$incidentId"
      params={{ incidentId: incident.id }}
    />
  );
}
