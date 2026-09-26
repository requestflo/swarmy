import * as React from 'react';
import type { PublicIncidentView } from '@swarmy/core';
import { StatusBadge, cn } from '@swarmy/ui';
import { TONE_TEXT } from '@/components/calm';
import { StreamPill } from '@/components/activity/stream-pill';
import { PHASE_LABEL, PHASE_TONE, hhmm } from './status-copy';

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * An incident's updates as visitors read them: the ones a person posted
 * (phase — message) when there are any, else the automatic feed.
 */
function Updates({ incident, clock }: { incident: PublicIncidentView; clock: (iso: string) => string }): React.JSX.Element | null {
  const posted = incident.publicUpdates ?? [];
  if (posted.length > 0) {
    return (
      <ul className="mt-3 space-y-2">
        {posted.map((u, idx) => (
          <li key={`${u.at}-${idx}`} className="flex gap-3 text-sm">
            <span className="mono-data text-muted-foreground min-w-12 shrink-0">{clock(u.at)}</span>
            <span className="text-foreground/90 min-w-0 break-words">
              <strong className={cn('font-semibold', TONE_TEXT[PHASE_TONE[u.phase]])}>{PHASE_LABEL[u.phase]}</strong> — {u.message}
            </span>
          </li>
        ))}
      </ul>
    );
  }
  if (incident.updates.length === 0) return null;
  return (
    <ul className="mt-3 space-y-2">
      {incident.updates.map((u, idx) => (
        <li key={`${u.at}-${idx}`} className="flex gap-3 text-sm">
          <span className="mono-data text-muted-foreground shrink-0">{clock(u.at)}</span>
          <span className="text-foreground/90 min-w-0 break-words">{u.message}</span>
        </li>
      ))}
    </ul>
  );
}

/** The ongoing incident, boxed above the components (the phase of its newest update). */
export function CurrentIncident({ incident }: { incident: PublicIncidentView }): React.JSX.Element {
  const phase = incident.publicUpdates?.[0]?.phase;
  return (
    <div className="border-border bg-card rounded-xl border px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-semibold">{incident.title}</p>
        {phase ? <StreamPill word={PHASE_LABEL[phase]} tone={PHASE_TONE[phase]} /> : null}
        <span className="mono-data text-muted-foreground ml-auto text-xs">started {hhmm(incident.openedAt)}</span>
      </div>
      <Updates incident={incident} clock={hhmm} />
    </div>
  );
}

function IncidentEntry({ incident }: { incident: PublicIncidentView }): React.JSX.Element {
  const open = incident.status === 'open';
  return (
    <div className="border-border border-b px-5 py-4 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">{incident.title}</p>
        <StatusBadge tone={open ? 'offline' : 'online'} label={open ? 'Ongoing' : 'Resolved'} />
      </div>
      <p className="mono-label text-muted-foreground mt-1">
        {when(incident.openedAt)}
        {incident.resolvedAt ? ` → ${when(incident.resolvedAt)}` : ' → now'}
      </p>
      <Updates incident={incident} clock={when} />
    </div>
  );
}

/** Public incident history — open first, then the last 30 days of resolved. */
export function PublicIncidents({ incidents }: { incidents: PublicIncidentView[] }): React.JSX.Element {
  if (incidents.length === 0) {
    return <p className="text-muted-foreground px-1 py-4 text-sm">No incidents in the last 30 days.</p>;
  }
  return (
    <div className="calm-card overflow-hidden p-0">
      {incidents.map((incident) => (
        <IncidentEntry key={incident.id} incident={incident} />
      ))}
    </div>
  );
}
