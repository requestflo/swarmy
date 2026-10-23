import * as React from 'react';
import { Depth } from '@/components/calm';
import { regionLabel } from '@/components/estate-map/map-flows';
import type { FleetGroup } from './fleet-model';
import { FleetLegend } from './fleet-legend';
import type { TileProps } from './fleet-map';
import { FleetTile } from './fleet-tile';

/** The map on a phone: one soft section per region, its server tiles stacked. */
export function FleetPhone({ groups, meshOn, ...tile }: { groups: FleetGroup[]; meshOn: boolean } & TileProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <FleetLegend meshOn={meshOn} />
      {groups.map((g) => (
        <section
          key={g.region ?? '~'}
          aria-label={g.region ? `Region ${g.region}` : 'Servers with no region'}
          className="bg-foreground/[0.035] border-foreground/15 flex flex-col gap-3 rounded-[28px] border p-3"
        >
          <header className="flex flex-col gap-0.5 px-2 pt-1">
            <h3 className="text-foreground/80 font-mono text-[12px] tracking-[0.12em] uppercase">{regionLabel(g.region)}</h3>
            {g.region ? null : <p className="text-muted-foreground text-[13px]">Set a region on the server to place it.</p>}
            <Depth at="controls">
              <p className="text-muted-foreground font-mono text-[12px]">{g.region ? `swarmy.region=${g.region}` : 'no swarmy.region label'}</p>
            </Depth>
          </header>
          {g.servers.map((s) => (
            <FleetTile
              key={s.server.node.id}
              v={s}
              selected={tile.selectedId === s.server.node.id}
              picking={tile.picking}
              picked={tile.picked.has(s.server.node.id)}
              onPick={tile.onPick}
              plan={null}
            />
          ))}
        </section>
      ))}
    </div>
  );
}
