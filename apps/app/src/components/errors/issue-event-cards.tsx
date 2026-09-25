import * as React from 'react';
import { Card, CardContent, CardHeader, CardTitle, cn } from '@swarmy/ui';
import { shortRelease, timeAgo } from './errors-shared';
import { StackTrace } from './stack-trace';
import type { IssueData, IssueEvent } from './issue-types';

/** The event column of an issue: its stack trace, breadcrumbs and the recent events to pick from. */
export function IssueEventCards({ d, ev, onPick }: { d: IssueData; ev: IssueEvent | null | undefined; onPick: (eventId: string) => void }): React.JSX.Element {
  return (
    <>
    <Card className="calm-card shadow-none">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
          <span>Stack trace</span>
          {ev ? (
            <span className="text-muted-foreground mono-label font-normal">
              event {ev.eventId.slice(0, 8)} · {timeAgo(ev.timestamp)}
            </span>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {ev?.exceptions.length ? (
          <StackTrace exceptions={ev.exceptions} />
        ) : (
          <p className="text-muted-foreground text-sm break-words">{ev?.message || 'No exception data on this event.'}</p>
        )}
      </CardContent>
    </Card>

    <Card className="calm-card shadow-none">
      <CardHeader>
        <CardTitle className="text-base">Breadcrumbs</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {ev?.breadcrumbs.length ? (
          <div className="border-t">
            {[...ev.breadcrumbs].reverse().map((b, i) => (
              <div key={i} className="grid grid-cols-[5.5rem_7rem_minmax(0,1fr)] gap-3 border-b px-6 py-2 text-xs last:border-b-0">
                <span className="text-muted-foreground mono-data">{b.timestamp ? new Date(b.timestamp).toLocaleTimeString() : '—'}</span>
                <span className={cn('mono-label truncate', b.level === 'error' && 'text-tone-bad', b.level === 'warning' && 'text-tone-warn')}>
                  {b.category || b.type}
                </span>
                <span className="min-w-0 break-words">
                  {b.message || (b.data ? <code className="mono-data">{JSON.stringify(b.data).slice(0, 240)}</code> : '—')}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground px-6 pb-6 text-sm">No breadcrumbs on this event.</p>
        )}
      </CardContent>
    </Card>

    <Card className="calm-card shadow-none">
      <CardHeader>
        <CardTitle className="text-base">Recent events</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="border-t">
          {d.events.map((e) => (
            <button
              key={e.eventId}
              type="button"
              onClick={() => onPick(e.eventId)}
              className={cn(
                'hover:bg-accent/60 grid w-full grid-cols-[6rem_minmax(0,1fr)_auto] items-center gap-3 border-b px-6 py-2 text-left text-xs last:border-b-0',
                ev?.eventId === e.eventId && 'bg-accent/40',
              )}
            >
              <span className="text-muted-foreground">{timeAgo(e.timestamp)}</span>
              <span className="truncate">
                {e.user || 'anonymous'} · {e.serverName || e.environment}
              </span>
              <span className="mono-data">{shortRelease(e.release)}</span>
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
    </>
  );
}
