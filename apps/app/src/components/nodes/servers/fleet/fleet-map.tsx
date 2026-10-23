import * as React from 'react';
import { Depth, useDepth } from '@/components/calm';
import { regionLabel } from '@/components/estate-map/map-flows';
import { BlobLayer, MeshLayer } from '@/components/estate-map/map-layers';
import { layoutMap, type GroupInput } from '@/components/estate-map/map-layout';
import { useMedia, useSize } from '@/components/estate-map/use-media';
import { DRAG_TYPE, useMove } from '../move/move-context';
import type { MovePlan } from '../move/use-move-plan';
import { FleetLegend } from './fleet-legend';
import { tileHeight, yours, type FleetGroup } from './fleet-model';
import { FleetTile } from './fleet-tile';

export interface TileProps {
  selectedId: string | null;
  picking: boolean;
  picked: Set<string>;
  onPick: (id: string) => void;
  plan: MovePlan | null;
}

/**
 * Board 11's map on a wide screen: region zones placed by rough geography
 * (the estate map's layout and blobs), each server as a ring tile, dashed
 * private-network links between them, and the legend. Text never scales;
 * the canvas grows instead.
 */
export function FleetMap({ groups, links, meshOn, ...tile }: { groups: FleetGroup[]; links: { a: string; b: string; ok: boolean }[]; meshOn: boolean } & TileProps): React.JSX.Element {
  const [ref, size] = useSize<HTMLDivElement>();
  const coarse = useMedia('(pointer: coarse)');
  const tech = useDepth().atLeast('controls');
  const m = useMove();
  const width = Math.max(size.w, 560);
  const input = React.useMemo<GroupInput[]>(
    () =>
      groups.map((g) => ({
        region: g.region,
        lat: g.lat,
        lon: g.lon,
        cards: g.servers.map((s) => ({ id: s.server.node.id, h: tileHeight({ chips: yours(s)?.length ?? 0, tech, coarse }) })),
      })),
    [groups, tech, coarse],
  );
  const layout = React.useMemo(() => layoutMap(input, width), [input, width]);
  const cards = React.useMemo(() => new Map(layout.blobs.flatMap((b) => b.cards.map((c) => [c.id, c] as const))), [layout]);
  const byId = new Map(groups.flatMap((g) => g.servers.map((s) => [s.server.node.id, s] as const)));
  const target = tile.plan ? (tile.plan.targets.find((t) => t.id === m.target) ?? null) : null;

  return (
    <div
      ref={ref}
      className="relative w-full"
      style={{ height: layout.height }}
      // A drag over the map but off every tile (tiles stop their own dragover) has no target.
      onDragOver={(e) => (e.dataTransfer.types.includes(DRAG_TYPE) ? m.hover(null) : undefined)}
    >
      {size.w > 0 ? (
        <>
          <FleetLegend meshOn={meshOn} className="absolute top-4 left-5" />
          <svg aria-hidden className="absolute inset-0 overflow-visible" width={layout.width} height={layout.height}>
            <BlobLayer layout={layout} />
            {meshOn ? <MeshLayer links={links} cards={cards} /> : null}
          </svg>
          {layout.blobs.map((b) => (
            <div
              key={b.region ?? '~'}
              className="absolute flex items-baseline gap-2 overflow-hidden font-mono text-[12px] whitespace-nowrap"
              style={{ left: b.x + 18, top: b.y + 6, maxWidth: b.w - 36 }}
            >
              <span className="text-foreground/80 shrink-0 tracking-[0.12em] uppercase">{regionLabel(b.region)}</span>
              {b.region ? null : <span className="text-muted-foreground">set a region on the server</span>}
              <Depth at="controls">
                <span className="text-muted-foreground truncate">{b.region ? `swarmy.region=${b.region}` : 'no swarmy.region label'}</span>
              </Depth>
            </div>
          ))}
          {[...cards.values()].map((c) => {
            const v = byId.get(c.id);
            if (!v) return null;
            return (
              <FleetTile
                key={c.id}
                v={v}
                selected={tile.selectedId === c.id}
                picking={tile.picking}
                picked={tile.picked.has(c.id)}
                onPick={tile.onPick}
                plan={target?.id === c.id ? target : null}
                className="absolute"
                style={{ left: c.x, top: c.y, width: c.w, height: c.h }}
              />
            );
          })}
        </>
      ) : null}
    </div>
  );
}
