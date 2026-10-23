import * as React from 'react';
import { cn } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { useMedia, useSize } from '@/components/estate-map/use-media';
import { dayMarks, eventsAt, WEEK_MS, type TravelEvent } from './time-travel-model';
import { TravelHeadRow } from './travel-head-row';
import { LANES, TravelLane } from './travel-lane';
import type { TravelHead } from './use-travel-head';

interface TravelTimelineProps {
  events: TravelEvent[];
  head: TravelHead;
  now: number;
  /** Some lanes couldn't be read. */
  partial?: boolean;
  className?: string;
}

const LABEL = 'text-muted-foreground flex h-11 items-center gap-2 text-[12.5px] font-semibold';

/**
 * The week as a bar (board 10): day marks, three lanes (Deploys · Incidents ·
 * Backups) and the head. Everything left of the head is "since then".
 */
export function TravelTimeline({ events, head, now, partial, className }: TravelTimelineProps): React.JSX.Element {
  const [trackRef, track] = useSize<HTMLDivElement>();
  const coarse = useMedia('(pointer: coarse)');
  const gap = track.w ? (coarse ? 46 : 26) / track.w : 0.04;
  const pos = Math.min(1, Math.max(0, (head.at - (now - WEEK_MS)) / WEEK_MS));
  // "On" an event: within a couple of pixels of the head, whatever the bar's width.
  const slack = track.w ? (3 / track.w) * WEEK_MS : 2 * 60_000;
  const current = new Set(head.live ? [] : eventsAt(events, head.at, slack).map((e) => e.id));
  const marks = dayMarks(now);

  return (
    <section aria-label="The last 7 days" className={cn('calm-card bg-card/95 px-4 pt-3 pb-2 backdrop-blur sm:px-5', className)}>
      <div className="grid grid-cols-[84px_minmax(0,1fr)] gap-x-3 pr-5 sm:grid-cols-[110px_minmax(0,1fr)]">
        <span className="calm-eyebrow flex h-6 items-center">7 days</span>
        <div className="relative h-6" aria-hidden>
          {marks.map((m) => (
            <span key={m.pos} className="text-muted-foreground absolute top-1 font-mono text-[11px] whitespace-nowrap" style={{ left: `${m.pos * 100}%` }}>
              <span className="hidden md:inline">{m.label.split(' ')[0]} </span>
              {m.label.split(' ')[1]}
            </span>
          ))}
        </div>
        {LANES.map((l) => (
          <React.Fragment key={l.kind}>
            <span className={LABEL}>
              <span aria-hidden className={cn('size-2 shrink-0 rounded-full', l.dot)} />
              {l.label}
            </span>
            <TravelLane kind={l.kind} events={events} current={current} gap={gap} pos={pos} onPick={head.go} />
          </React.Fragment>
        ))}
        <span className={cn(LABEL, 'font-mono text-[11px] font-normal')}>drag the head</span>
        <TravelHeadRow head={head} now={now} pos={pos} trackRef={trackRef} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1">
        {partial ? <span className="text-tone-warn text-[12px]">Some backups or incidents couldn&rsquo;t be read, so a lane may be missing events.</span> : null}
        <Tech>releases.list · incidents.list + incidents.get · backups.listSnapshots · dbBackups.list</Tech>
      </div>
    </section>
  );
}
