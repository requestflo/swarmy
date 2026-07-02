import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ChevronRightIcon } from 'lucide-react';
import type { IncidentView } from '@swarmy/core';
import { IncidentStatusChip, SeverityChip, formatDuration, relativeTime } from './incident-status';

/** One incident as a flat hairline row — the whole row links to the timeline. */
export function IncidentRow({ incident }: { incident: IncidentView }): React.JSX.Element {
  return (
    <Link
      to="/incidents/$incidentId"
      params={{ incidentId: incident.id }}
      className="hover:bg-accent/50 group flex w-full items-center gap-4 border-b px-6 py-4 transition-colors last:border-b-0"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{incident.title}</span>
          <SeverityChip severity={incident.severity} />
        </div>
        <p className="text-muted-foreground mt-0.5 truncate text-xs">
          {incident.status === 'open'
            ? `Opened ${relativeTime(incident.openedAt)}`
            : `Resolved ${incident.resolvedAt ? relativeTime(incident.resolvedAt) : ''}`}
          {' · '}
          <span className="mono-data">{formatDuration(incident.durationSec)}</span>
          {incident.status === 'open' ? ' and counting' : ' total'}
        </p>
      </div>
      <div className="hidden shrink-0 text-right sm:block">
        <p className="mono-data text-sm">{incident.eventCount}</p>
        <p className="mono-label text-muted-foreground">events</p>
      </div>
      <IncidentStatusChip status={incident.status} className="shrink-0" />
      <ChevronRightIcon className="text-muted-foreground size-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}
