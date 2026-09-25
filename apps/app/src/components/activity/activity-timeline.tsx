import * as React from 'react';
import { cn } from '@swarmy/ui';
import { Section } from '@/components/calm';
import type { ActivityItem, ActivityKind } from './activity-items';
import { ActivityRow } from './activity-row';

const FILTERS: { key: ActivityKind | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'alert', label: 'Alerts' },
  { key: 'incident', label: 'Incidents' },
  { key: 'deploy', label: 'Deploys' },
  { key: 'change', label: 'Changes' },
];

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/** The single timeline: one quiet section, filter chips, rows grouped by day. */
export function ActivityTimeline({ items }: { items: ActivityItem[] }): React.JSX.Element {
  const [filter, setFilter] = React.useState<ActivityKind | 'all'>('all');
  const shown = filter === 'all' ? items : items.filter((i) => i.kind === filter);
  const groups: { day: string; rows: ActivityItem[] }[] = [];
  for (const it of shown.slice(0, 80)) {
    const day = dayLabel(it.at);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.rows.push(it);
    else groups.push({ day, rows: [it] });
  }
  return (
    <Section title="Timeline" count={`${shown.length} events`} hint="newest first" flush>
      <div role="group" aria-label="Show" className="flex flex-wrap gap-1.5 pb-2">
        {FILTERS.map((f) => {
          const n = f.key === 'all' ? items.length : items.filter((i) => i.kind === f.key).length;
          const on = f.key === filter;
          return (
            <button
              key={f.key}
              type="button"
              aria-pressed={on}
              onClick={() => setFilter(f.key)}
              className={cn(
                'h-8 rounded-full border px-3 text-[12.5px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:min-h-11',
                on ? 'bg-surface-2 border-border text-foreground dark:bg-accent' : 'text-muted-foreground hover:text-foreground border-transparent',
              )}
            >
              {f.label} <span className="font-mono text-[11px]">{n}</span>
            </button>
          );
        })}
      </div>
      {groups.length === 0 ? (
        <p className="text-muted-foreground py-6 text-sm">Nothing here yet. Deploys, alerts and changes show up the moment they happen.</p>
      ) : (
        groups.map((g) => (
          <div key={g.day} className="flex flex-col">
            <h3 className="calm-eyebrow pt-3 pb-1">{g.day}</h3>
            {g.rows.map((it) => (
              <ActivityRow key={it.id} item={it} />
            ))}
          </div>
        ))
      )}
    </Section>
  );
}
