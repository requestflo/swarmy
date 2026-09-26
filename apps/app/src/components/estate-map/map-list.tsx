import * as React from 'react';
import { Depth } from '@/components/calm';
import type { RegionGroup } from './estate-model';
import type { Lens } from './lens-control';
import { regionLabel, visitorsLine, type RegionTraffic } from './map-flows';
import { ServerCard } from './server-card';

/**
 * The map on a phone: one section per region (a soft blob header, the
 * visitors line in place of the flow), then its server cards stacked.
 */
export function MapList({ groups, lens, traffic }: { groups: RegionGroup[]; lens: Lens; traffic: Map<string | null, RegionTraffic> }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => {
        const t = traffic.get(g.region);
        return (
          <section
            key={g.region ?? '~'}
            aria-label={g.region ? `Region ${g.region}` : 'Servers with no region'}
            className="bg-foreground/[0.035] border-foreground/15 flex flex-col gap-3 rounded-[28px] border p-3"
          >
            <header className="flex flex-col gap-0.5 px-2 pt-1">
              <h3 className="text-foreground/80 font-mono text-[12px] tracking-[0.12em] uppercase">{regionLabel(g.region)}</h3>
              {lens === 'traffic' && t ? (
                <p className={t.rate === null ? 'text-muted-foreground text-[13px]' : 'text-foreground text-[13px] font-semibold'}>
                  {t.rate === null ? 'No traffic data yet' : visitorsLine(t.rate)}
                </p>
              ) : null}
              {g.region ? null : <p className="text-muted-foreground text-[13px]">Set a region on the server to place it.</p>}
              <Depth at="controls">
                <p className="text-muted-foreground font-mono text-[12px]">{g.region ? `swarmy.region=${g.region}` : 'no swarmy.region label'}</p>
              </Depth>
            </header>
            {g.servers.map((s) => (
              <ServerCard key={s.node.id} s={s} lens={lens} />
            ))}
          </section>
        );
      })}
    </div>
  );
}
