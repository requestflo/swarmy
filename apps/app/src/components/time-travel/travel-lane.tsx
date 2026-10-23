import * as React from 'react';
import { cn } from '@swarmy/ui';
import { groupEvents, momentLabel, type TravelEvent, type TravelKind } from './time-travel-model';

export const LANES: { kind: TravelKind; label: string; dot: string }[] = [
  { kind: 'deploy', label: 'Deploys', dot: 'bg-status-progress' },
  { kind: 'incident', label: 'Incidents', dot: 'bg-status-warning' },
  { kind: 'backup', label: 'Backups', dot: 'bg-status-online' },
];

const pct = (pos: number): string => `${(pos * 100).toFixed(3)}%`;

/** The head's 2px line, drawn in each row so the rows read as one bar. */
export function HeadLine({ pos }: { pos: number }): React.JSX.Element {
  return <span aria-hidden className="bg-foreground/70 pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2" style={{ left: pct(pos) }} />;
}

/** One event's mark: a bar for deploys and incidents, a diamond for backups (crimson when it failed). */
function Mark({ e }: { e: TravelEvent }): React.JSX.Element {
  if (e.kind === 'backup') {
    return <span className={cn('size-2.5 shrink-0 rotate-45 rounded-[3px]', e.failed ? 'bg-status-offline' : 'bg-status-online')} />;
  }
  return <span className={cn('h-5 shrink-0 rounded-full transition-[height] group-hover:h-7', e.kind === 'deploy' ? 'bg-status-progress w-[3px]' : 'bg-status-warning w-2.5 rounded-sm')} />;
}

interface TravelLaneProps {
  kind: TravelKind;
  events: TravelEvent[];
  /** Ids of the events the head is on. */
  current: Set<string>;
  /** A lane button's width as a share of the bar (24px, 44px on touch). */
  gap: number;
  pos: number;
  onPick: (t: number) => void;
}

/**
 * A lane of the week: each event (or a run of close ones) is one button that
 * puts the head on it; clicking a run again walks through it.
 */
export function TravelLane({ kind, events, current, gap, pos, onPick }: TravelLaneProps): React.JSX.Element {
  const groups = groupEvents(events.filter((e) => e.kind === kind), gap);
  return (
    <div className="relative h-11">
      <span aria-hidden className="bg-border absolute top-1/2 right-0 left-0 h-px" />
      <HeadLine pos={pos} />
      {groups.map((g) => {
        const on = g.findIndex((e) => current.has(e.id));
        const next = g[(on + 1) % g.length]!;
        const label = g.map((e) => `${e.title}, ${momentLabel(e.at)}`).join('; ');
        return (
          <button
            key={g[0]!.id}
            type="button"
            aria-label={label}
            aria-pressed={on >= 0}
            title={label}
            onClick={() => onPick(on >= 0 ? next.at : g[0]!.at)}
            className={cn(
              'group absolute top-0 flex h-11 w-6 -translate-x-1/2 items-center justify-center gap-[3px] rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:w-11',
              on >= 0 && 'bg-foreground/10',
            )}
            style={{ left: pct(g[0]!.pos) }}
          >
            {g.slice(0, 3).map((e) => (
              <Mark key={e.id} e={e} />
            ))}
          </button>
        );
      })}
    </div>
  );
}
