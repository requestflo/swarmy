import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { cn } from '@swarmy/ui';
import type { ActivityItem, StreamFilter } from './activity-items';
import { ActivityRow } from './activity-row';

const LABEL: Record<StreamFilter, string> = { all: 'All', alert: 'Alerts', incident: 'Incidents', deploy: 'Deploys', backup: 'Backups' };
const ORDER: StreamFilter[] = ['all', 'alert', 'incident', 'deploy', 'backup'];

/** "TODAY · THU 24 SEP" / "YESTERDAY" / "TUE 22 SEP". */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  const date = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
  if (d.toDateString() === now.toDateString()) return `Today · ${date}`;
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return date;
}

/** The Stream: filter chips with real counts, then rows grouped by day on one rail. */
export function ActivityTimeline({
  items,
  filter,
  selectedId,
}: {
  items: ActivityItem[];
  filter: StreamFilter;
  selectedId?: string;
}): React.JSX.Element {
  const shown = filter === 'all' ? items : items.filter((i) => i.kind === filter);
  const groups: { day: string; rows: ActivityItem[] }[] = [];
  for (const it of shown.slice(0, 80)) {
    const day = dayLabel(it.at);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.rows.push(it);
    else groups.push({ day, rows: [it] });
  }
  return (
    <section aria-label="Stream" className="flex min-w-0 flex-col gap-3">
      <div role="group" aria-label="Show" className="flex flex-wrap gap-1">
        {ORDER.map((key) => {
          const n = key === 'all' ? items.length : items.filter((i) => i.kind === key).length;
          const on = key === filter;
          return (
            <Link
              key={key}
              to="/activity"
              search={key === 'all' ? {} : { filter: key }}
              aria-pressed={on}
              className={cn(
                'inline-flex h-9 items-center gap-1.5 rounded-[10px] px-3 text-[13px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:min-h-11',
                on ? 'bg-surface-2 text-foreground dark:bg-accent' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {LABEL[key]} <span className="font-mono text-[11px] font-normal">{n}</span>
            </Link>
          );
        })}
      </div>
      {groups.length === 0 ? (
        <p className="text-muted-foreground calm-card px-5 py-6 text-sm">
          {filter === 'all' ? 'Nothing here yet. Deploys, alerts and backups show up the moment they happen.' : `No ${LABEL[filter].toLowerCase()} in the stream yet.`}
        </p>
      ) : (
        <div className="relative">
          <span aria-hidden className="bg-border absolute top-2 bottom-2 left-[73px] w-px" />
          {groups.map((g) => (
            <div key={g.day} className="relative flex flex-col">
              <h3 className="calm-eyebrow ml-[94px] pt-3 pb-1 uppercase">{g.day}</h3>
              {g.rows.map((it) => (
                <ActivityRow key={it.id} item={it} filter={filter} selected={Boolean(it.incidentId && it.incidentId === selectedId)} />
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
