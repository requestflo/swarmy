import * as React from 'react';
import { cn } from '@swarmy/ui';
import { lastAt, type Timeline, type TimelineRow } from './replay-timeline';
import { ReplayEventRow } from './replay-event-row';

type PanelTab = 'requests' | 'traces' | 'errors' | 'logs';
const TABS: { key: PanelTab; label: string }[] = [
  { key: 'requests', label: 'Requests' },
  { key: 'traces', label: 'Traces' },
  { key: 'errors', label: 'Errors' },
  { key: 'logs', label: 'Logs' },
];

const EMPTY: Record<PanelTab, string> = {
  requests: 'No requests recorded in this visit.',
  traces: 'No server traces linked. Turn on telemetry for this app to see them.',
  errors: 'No errors in this visit.',
  logs: 'No server logs linked to this visit.',
};

interface ReplaySidePanelProps {
  stack: string;
  timeline: Timeline;
  time: number;
  onSeek: (t: number) => void;
}

/** This visit, synced to the player: requests, traces, errors and logs by time. */
export function ReplaySidePanel({ stack, timeline, time, onSeek }: ReplaySidePanelProps): React.JSX.Element {
  const [tab, setTab] = React.useState<PanelTab>(timeline.errors.length ? 'errors' : 'requests');
  const rows: TimelineRow[] = timeline[tab];
  const now = lastAt(rows, time);

  return (
    <aside className="calm-card shadow-none flex min-h-0 flex-col gap-2 p-4" aria-label="This visit">
      <div role="tablist" className="flex flex-wrap gap-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold transition-colors',
              tab === t.key ? 'bg-ink text-ink-foreground' : 'text-muted-foreground hover:bg-accent',
            )}
          >
            {t.label}
            <span className="font-mono text-[10.5px] opacity-70">{timeline[t.key].length}</span>
          </button>
        ))}
      </div>
      <p className="text-muted-foreground text-xs">Click any row to jump the replay to that moment.</p>
      {rows.length === 0 ? (
        <p className="text-muted-foreground py-6 text-center text-sm">{EMPTY[tab]}</p>
      ) : (
        <ul className="-mx-1 flex max-h-[520px] min-h-0 flex-col gap-0.5 overflow-x-hidden overflow-y-auto px-1">
          {rows.map((r) => (
            <ReplayEventRow
              key={r.key}
              stack={stack}
              row={r}
              state={r === now ? 'now' : r.t <= time ? 'past' : 'future'}
              onSeek={onSeek}
            />
          ))}
        </ul>
      )}
    </aside>
  );
}
