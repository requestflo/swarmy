import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { HistoryIcon } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger, cn } from '@swarmy/ui';
import { Depth } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { groupTicks, rewindStart, rewindTicks, type TickGroup, type TickKind } from './rewind-ticks';
import { useMedia, useSize } from './use-media';

const KIND: Record<TickKind, { label: string; fill: string }> = {
  deploy: { label: 'deploy', fill: 'bg-status-progress' },
  backup: { label: 'backup', fill: 'bg-status-online' },
  incident: { label: 'incident', fill: 'bg-status-warning' },
};

function Tick({ g }: { g: TickGroup }): React.JSX.Element {
  const label = g.ticks.map((t) => `${KIND[t.kind].label}: ${t.title}, ${t.detail}`).join('; ');
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="group absolute top-0 flex h-11 w-6 -translate-x-1/2 pointer-coarse:w-11 items-center justify-center gap-[3px] rounded outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          style={{ left: `${g.pos * 100}%` }}
        >
          {g.ticks.slice(0, 3).map((t) => (
            <span key={t.id} aria-hidden className={cn('h-5 w-[3px] shrink-0 rounded-full transition-[height] group-hover:h-7 group-data-[state=open]:h-7', KIND[t.kind].fill)} />
          ))}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" className="flex w-72 flex-col gap-3 p-3">
        {g.ticks.map((t) => (
          <div key={t.id} className="flex flex-col gap-1">
            <span className="text-muted-foreground inline-flex items-center gap-1.5 font-mono text-[12px]">
              <span aria-hidden className={cn('h-3 w-[3px] rounded-full', KIND[t.kind].fill)} />
              {t.detail}
            </span>
            <span className="text-foreground text-[14px] leading-snug font-semibold">{t.title}</span>
            <Link to={t.link.to} params={t.link.params as never} className="text-foreground inline-flex items-center text-[13px] font-medium underline underline-offset-2 pointer-coarse:min-h-11">
              {t.link.label} →
            </Link>
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Rewind: the last 24 hours as ticks (deploys from `releases.list`, backup
 * runs from `backups.listSnapshots`, incidents from `incidents.list`). A tick
 * opens what happened then, with a link to it. It doesn't replay the map.
 */
export function RewindBar(): React.JSX.Element {
  const trpc = useTRPC();
  const releases = useQuery({ ...trpc.releases.list.queryOptions({ limit: 100 }), refetchInterval: 30_000 });
  const snaps = useQuery({ ...trpc.backups.listSnapshots.queryOptions({}), refetchInterval: 60_000 });
  const incidents = useQuery({ ...trpc.incidents.list.queryOptions({ limit: 50 }), refetchInterval: 30_000 });
  const now = Date.now();
  const ticks = React.useMemo(
    () => rewindTicks({ releases: releases.data, snapshots: snaps.data, incidents: incidents.data, now }),
    // `now` moves every render; the ticks only need to follow the data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [releases.data, snaps.data, incidents.data],
  );
  const counts = (k: TickKind) => ticks.filter((t) => t.kind === k).length;
  const [barRef, bar] = useSize<HTMLDivElement>();
  const coarse = useMedia('(pointer: coarse)');
  // One target per stretch of the bar (24px, 44px on touch), whatever its width.
  const target = coarse ? 46 : 26;
  const groups = React.useMemo(() => groupTicks(ticks, bar.w ? target / bar.w : 0.04), [ticks, bar.w, target]);

  return (
    <section aria-label="Rewind: the last 24 hours" className="calm-card bg-card flex flex-col gap-2 px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-5">
      <span className="text-foreground inline-flex shrink-0 items-center gap-2 text-[13px] font-semibold">
        <HistoryIcon aria-hidden className="size-4" /> Rewind
        <span className="text-muted-foreground font-normal">last 24 h</span>
      </span>
      <div className="min-w-0 flex-1 sm:basis-[320px]">
        <div ref={barRef} className="relative h-11">
          <span aria-hidden className="bg-border absolute top-1/2 right-0 left-0 h-px" />
          {groups.map((g) => (
            <Tick key={g.id} g={g} />
          ))}
          <span aria-hidden className="bg-foreground absolute top-1/2 right-0 size-2.5 translate-x-1/2 -translate-y-1/2 rounded-full" />
        </div>
        <div className="text-muted-foreground flex justify-between font-mono text-[12px]">
          <span>{rewindStart(now)}</span>
          <span>now</span>
        </div>
      </div>
      <ul className="flex shrink-0 flex-wrap gap-x-4 gap-y-1 font-mono text-[12px]" aria-label="Legend">
        {(Object.keys(KIND) as TickKind[]).map((k) => (
          <li key={k} className="text-muted-foreground inline-flex items-center gap-1.5">
            <span aria-hidden className={cn('h-3 w-[3px] rounded-full', KIND[k].fill)} />
            {KIND[k].label} <span className="text-foreground">{counts(k)}</span>
          </li>
        ))}
      </ul>
      <Depth at="controls">
        <p className="text-muted-foreground w-full font-mono text-[12px]">Rewind shows what happened; replaying the map is not built.</p>
      </Depth>
    </section>
  );
}
