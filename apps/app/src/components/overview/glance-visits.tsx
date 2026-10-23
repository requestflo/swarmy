import * as React from 'react';
import type { TrafficNowView } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { TONE_DOT, Tech } from '@/components/calm';
import { TextSkeleton } from '@/components/states';
import { perMin } from '@/components/estate-map/map-flows';
import { serverTone, visitsByArea } from './glance-words';
import type { ServerGlance } from './use-servers-glance';

/**
 * The estate in one card: visits a minute at the front doors (`traffic.now`),
 * where they come from, and every server as a dot. There is no estate-wide
 * uptime source, so no uptime figure; no edge reporting is "no data yet".
 */
export function GlanceVisits({ traffic, servers }: { traffic: TrafficNowView | undefined; servers: ServerGlance[] }): React.JSX.Element {
  const rate = traffic ? (traffic.totals.state === 'no-data' ? null : traffic.totals.requestsPerMin) : undefined;
  const from = visitsByArea(traffic?.regions ?? []);
  const online = servers.filter((s) => s.node.status === 'online').length;
  return (
    <section aria-label="Right now" className="calm-card flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="flex items-baseline gap-1.5">
          <span className="font-mono text-[26px] leading-none font-semibold tabular-nums">
            {rate === undefined ? <TextSkeleton className="w-14" /> : rate === null ? '—' : perMin(rate)}
          </span>
          <span className="text-muted-foreground text-[13px]">{rate === null ? 'visits/min · no data yet' : 'visits/min'}</span>
        </p>
        <span className="text-muted-foreground font-mono text-[11.5px]">
          {online} of {servers.length} servers online
        </span>
      </div>
      {from ? <p className="text-muted-foreground font-mono text-[11.5px] leading-relaxed">{from}</p> : null}
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
      <Tech>traffic.now · requests/min over the last {traffic?.windowMinutes ?? 5} min at the edge</Tech>
    </section>
  );
}
