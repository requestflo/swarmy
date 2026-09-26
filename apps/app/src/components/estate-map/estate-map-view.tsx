import * as React from 'react';
import { useDepth } from '@/components/calm';
import { CardSkeleton } from '@/components/states';
import { plural } from '@/components/apps/app-words';
import type { SayParts } from '@/components/apps/estate-say';
import type { AppsBoard } from '@/components/apps/use-apps-board';
import { useMinWidth } from '@/lib/use-min-width';
import { LensControl, type Lens } from './lens-control';
import { MapCanvas } from './map-canvas';
import { MapList } from './map-list';
import { RewindBar } from './rewind-bar';
import { RightNowCard } from './right-now-card';
import { useEstateMap } from './use-estate-map';
import { useSize } from './use-media';

const CARD_W = 360;

/**
 * The Apps page's Map view (boards 6 and 22): your servers in soft region
 * blobs placed by rough geography, visitor flows into each region, the
 * Right-now card and Rewind. A view of Apps (List | Map), never a nav row.
 * Phones get the same map as a list of regions.
 */
export function EstateMapView({ b, say, servers, channels }: { b: AppsBoard; say: SayParts; servers: { online: number; total: number }; channels: number }): React.JSX.Element {
  const m = useEstateMap(b);
  const [lens, setLens] = React.useState<Lens>('traffic');
  const [cardRef, cardSize] = useSize<HTMLDivElement>();
  const lg = useMinWidth(1024);
  const xl = useMinWidth(1280);
  const code = useDepth().atLeast('code');
  const float = xl && !code;
  const needsYou = b.rows.find((r) => r.env === 'production' && r.status === 'attn' && r.fix);
  const visits = b.traffic ? (b.traffic.totals.state === 'no-data' ? null : b.traffic.totals.requestsPerMin) : undefined;
  const regions = new Set((m.groups ?? []).map((g) => g.region).filter(Boolean)).size;

  const card = (className?: string) => (
    <RightNowCard say={say} needsYou={needsYou} visits={visits} monthlyUsd={m.monthlyUsd} servers={servers} channels={channels} className={className} />
  );

  return (
    <div className="flex flex-col gap-4">
      {lg ? null : card()}
      <section aria-label="Map of your servers" className="calm-card relative overflow-hidden">
        <div className="border-border flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2.5">
          <p className="text-muted-foreground font-mono text-[12px]">
            {m.groups ? `${plural(servers.total, 'server')} · ${plural(regions, 'region')}` : 'Finding your servers…'}
          </p>
          <div className="flex-1" />
          <LensControl lens={lens} onChange={setLens} />
        </div>
        {!m.groups ? (
          <div className="p-4">
            <CardSkeleton />
          </div>
        ) : lg ? (
          <MapCanvas
            groups={m.groups}
            lens={lens}
            traffic={m.traffic}
            links={m.links}
            clear={float && cardSize.h ? { w: CARD_W + 16, h: cardSize.h + 28 } : { w: 0, h: 0 }}
          />
        ) : (
          <div className="p-3">
            <MapList groups={m.groups} lens={lens} traffic={m.traffic} />
          </div>
        )}
        {float ? (
          <div ref={cardRef} className="absolute top-[68px] right-4 w-[360px]">
            {card()}
          </div>
        ) : null}
      </section>
      {lg && !float ? card() : null}
      <RewindBar />
    </div>
  );
}
