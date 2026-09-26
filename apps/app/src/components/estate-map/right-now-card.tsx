import * as React from 'react';
import { cn } from '@swarmy/ui';
import { AlreadyOn, Say, SayHeader } from '@/components/calm';
import { TextSkeleton } from '@/components/states';
import { clockWords } from '@/components/apps/app-board-words';
import type { BoardRow } from '@/components/apps/app-board-model';
import type { SayParts } from '@/components/apps/estate-say';
import { estateAlreadyOn } from '@/components/overview/estate-already-on';
import { useSetupFacts } from '@/components/overview/use-setup-facts';
import { perMin } from './map-flows';
import { NeedsYouItem } from './needs-you-item';

function Kpi({ value, label }: { value: React.ReactNode; label: string }): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="text-foreground font-mono text-[20px] font-semibold tabular-nums">{value}</span>
      <span className="text-muted-foreground text-[12px]">{label}</span>
    </div>
  );
}

/**
 * Right now: the Apps sentence (the same `appsSay` hook as the list), the
 * one thing that needs you, what's already on, and three numbers: visits a
 * minute (`traffic.now`), servers online and $ a month (`cost.overview`).
 * There is no estate-wide 30-day uptime source, so uptime is left out.
 */
export function RightNowCard({
  say,
  needsYou,
  visits,
  monthlyUsd,
  servers,
  channels,
  className,
}: {
  say: SayParts;
  needsYou: BoardRow | undefined;
  /** Requests a minute at the front doors; null = no edge reporting; undefined = loading. */
  visits: number | null | undefined;
  monthlyUsd: number | null | undefined;
  servers: { online: number; total: number };
  channels: number;
  className?: string;
}): React.JSX.Element {
  const setup = useSetupFacts();
  const on = setup.ready ? estateAlreadyOn(setup, { channels, servers: servers.total }) : [];
  return (
    <section aria-label="Right now" className={cn('calm-card bg-card flex flex-col gap-4 p-5 shadow-lg', className)}>
      <SayHeader
        size="md"
        eyebrow={`Right now · ${clockWords(Date.now())}`}
        title={
          <>
            {say.lead} {say.clause ? <Say tone={say.clause.tone}>{say.clause.text}</Say> : null}
          </>
        }
      />
      {needsYou ? <NeedsYouItem row={needsYou} /> : null}
      {on.length ? (
        <div className="flex flex-col gap-2">
          <span className="calm-eyebrow">Already on</span>
          <AlreadyOn items={on} bare />
        </div>
      ) : null}
      <div className="border-border grid grid-cols-3 gap-3 border-t pt-4">
        <Kpi value={visits === undefined ? <TextSkeleton className="w-12" /> : visits === null ? '—' : perMin(visits)} label={visits === null ? 'visits / min · no data yet' : 'visits / min'} />
        <Kpi value={`${servers.online}/${servers.total}`} label="servers online" />
        <Kpi value={monthlyUsd === undefined ? <TextSkeleton className="w-12" /> : monthlyUsd === null ? '—' : `$${Math.round(monthlyUsd)}`} label={monthlyUsd === null ? 'no prices set' : 'per month'} />
      </div>
    </section>
  );
}
