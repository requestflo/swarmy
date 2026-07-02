import * as React from 'react';
import type { PublicIncidentView } from '@swarmy/core';
import { StatusBadge } from '@swarmy/ui';

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function IncidentEntry({ incident }: { incident: PublicIncidentView }): React.JSX.Element {
  const open = incident.status === 'open';
  return (
    <div className="border-border border-b px-5 py-4 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">{incident.title}</p>
        <StatusBadge
          tone={open ? 'offline' : 'online'}
          label={open ? 'Ongoing' : 'Resolved'}
        />
      </div>
      <p className="mono-label text-muted-foreground mt-1">
        {when(incident.openedAt)}
        {incident.resolvedAt ? ` → ${when(incident.resolvedAt)}` : ' → now'}
      </p>
      {incident.updates.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {incident.updates.map((u, idx) => (
            <li key={`${u.at}-${idx}`} className="flex gap-3 text-sm">
              <span className="mono-data text-muted-foreground shrink-0">{when(u.at)}</span>
              <span className="text-foreground/90 min-w-0">{u.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Public incident history — open first, then the last 30 days of resolved. */
export function PublicIncidents({
  incidents,
}: {
  incidents: PublicIncidentView[];
}): React.JSX.Element {
  if (incidents.length === 0) {
    return (
      <p className="text-muted-foreground px-1 py-4 text-sm">
        No incidents in the last 30 days.
      </p>
    );
  }
  return (
    <div className="card-pop overflow-hidden p-0">
      {incidents.map((incident) => (
        <IncidentEntry key={incident.id} incident={incident} />
      ))}
    </div>
  );
}
