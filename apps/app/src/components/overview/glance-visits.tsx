import * as React from 'react';
import type { EstateUptimeView, TrafficNowView } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { TONE_DOT, Tech } from '@/components/calm';
import { TextSkeleton } from '@/components/states';
import { perMin } from '@/components/estate-map/map-flows';
import { serverTone, visitsByArea } from './glance-words';
import { uptimeWords } from './uptime-words';
import type { ServerGlance } from './use-servers-glance';

/**
 * The estate in one card: visits a minute at the front doors (`traffic.now`)
 * beside the estate's uptime over 30 days (`estate.uptime`, saying what it's
 * from, or that there isn't enough data yet), where the visits come from, and
 * every server as a dot. No edge reporting is "no data yet", never a zero.
 */
export function GlanceVisits({ traffic, uptime, servers }: { traffic: TrafficNowView | undefined; uptime: EstateUptimeView | undefined; servers: ServerGlance[] }): React.JSX.Element {
  const rate = traffic ? (traffic.totals.state === 'no-data' ? null : traffic.totals.requestsPerMin) : undefined;
  const from = visitsByArea(traffic?.regions ?? []);
  const online = servers.filter((s) => s.node.status === 'online').length;
  const up = uptime ? uptimeWords(uptime) : undefined;
  return (
    <section aria-label="Right now" className="calm-card flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
          <span className="font-mono text-[26px] leading-none font-semibold tabular-nums">
            {rate === undefined ? <TextSkeleton className="w-14" /> : rate === null ? '—' : perMin(rate)}
          </span>
          <span className="text-muted-foreground text-[13px]">{rate === null ? 'visits/min · no data yet' : 'visits/min'}</span>
        </p>
        <p className="flex shrink-0 flex-col items-end gap-0.5 text-right">
          {!up ? (
            <TextSkeleton className="w-20" />
          ) : (
            <span className={cn(up.figure ? 'font-mono text-[15px] font-semibold tabular-nums' : 'text-muted-foreground text-[12.5px] font-semibold')}>
              {up.figure ?? 'Uptime: not enough data'}
            </span>
          )}
          {up?.figure ? <span className="text-muted-foreground max-w-[11rem] text-[11.5px] leading-snug">{up.basis}</span> : null}
        </p>
      </div>
      {from ? <p className="text-muted-foreground font-mono text-[11.5px] leading-relaxed">{from}</p> : null}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <ul aria-label="Servers" className="flex flex-wrap gap-x-3.5 gap-y-1.5">
          {servers.map((s) => {
            const t = serverTone(s);
            return (
              <li key={s.node.id} className="text-foreground/85 flex items-center gap-1.5 font-mono text-[11.5px]">
                <span aria-hidden className={cn('size-2 shrink-0 rounded-full', TONE_DOT[t.tone], t.tone === 'warn' && 'motion-safe:animate-pulse')} />
                {s.node.name}
                <span className="sr-only">: {t.word}</span>
              </li>
            );
          })}
        </ul>
        <span className="text-muted-foreground font-mono text-[11.5px]">
          {online} of {servers.length} online
        </span>
      </div>
      <Tech>traffic.now · requests/min over the last {traffic?.windowMinutes ?? 5} min at the edge</Tech>
      {up ? <Tech>{up.tech}</Tech> : null}
    </section>
  );
}
