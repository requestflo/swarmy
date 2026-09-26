import * as React from 'react';
import { Depth, useDepth } from '@/components/calm';
import type { RegionGroup } from './estate-model';
import { layoutInput } from './estate-model';
import type { Lens } from './lens-control';
import { flowLabel, flowsFor, regionArea, regionLabel, type RegionTraffic } from './map-flows';
import { BlobLayer, FlowLayer, MeshLayer } from './map-layers';
import { layoutMap } from './map-layout';
import { ServerCard } from './server-card';
import { useMedia, useSize } from './use-media';

interface Props {
  groups: RegionGroup[];
  lens: Lens;
  traffic: Map<string | null, RegionTraffic>;
  links: { a: string; b: string; ok: boolean }[];
  /** A top-right area to keep clear (the floating Right-now card), 0 × 0 for none. */
  clear: { w: number; h: number };
}

/**
 * The geographic estate at real size: region blobs placed by rough geography,
 * server cards inside them, visitor flows (Traffic) or private-network links
 * (Mesh) drawn under the cards. Text is never scaled; the canvas grows instead.
 */
export function MapCanvas({ groups, lens, traffic, links, clear }: Props): React.JSX.Element {
  const [ref, size] = useSize<HTMLDivElement>();
  const measured = size.w;
  const still = useMedia('(prefers-reduced-motion: reduce)');
  const coarse = useMedia('(pointer: coarse)');
  const tech = useDepth().atLeast('controls');
  const width = Math.max(measured, 560);
  const keepClear = React.useMemo(() => (clear.w ? [{ x: width - clear.w, y: 0, w: clear.w, h: clear.h }] : []), [width, clear.w, clear.h]);
  const layout = React.useMemo(() => layoutMap(layoutInput(groups, { tech, coarse }), width, keepClear), [groups, tech, coarse, width, keepClear]);
  const flows = React.useMemo(
    () => (lens === 'traffic' ? flowsFor(layout.blobs, traffic, { width: layout.width, keepClear }) : []),
    [lens, layout, traffic, keepClear],
  );
  const cards = React.useMemo(() => new Map(layout.blobs.flatMap((b) => b.cards.map((c) => [c.id, c] as const))), [layout]);
  const byId = new Map(groups.flatMap((g) => g.servers.map((s) => [s.node.id, s] as const)));
  const height = layout.height;

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {measured > 0 ? (
        <>
          <svg aria-hidden className="absolute inset-0 overflow-visible" width={layout.width} height={height}>
            <BlobLayer layout={layout} />
            {lens === 'mesh' ? <MeshLayer links={links} cards={cards} /> : null}
            <FlowLayer flows={flows} still={still} />
          </svg>
          {flows.map((f) => (
            <p key={f.region ?? '~'} className="bg-card/85 absolute max-w-[290px] truncate rounded px-1 font-mono text-[12px]" style={{ left: f.label.x, top: f.label.y }}>
              <span className="text-muted-foreground">{flowLabel(f.region, f.rate).split(' · ')[0]} · </span>
              <span className="text-foreground font-semibold">{flowLabel(f.region, f.rate).split(' · ')[1]}</span>
              <Depth at="controls">
                <span className="text-muted-foreground"> · {f.region ?? 'no region'}</span>
              </Depth>
            </p>
          ))}
          {layout.blobs.map((b) => {
            const t = traffic.get(b.region);
            return (
              <div
                key={b.region ?? '~'}
                className="absolute flex items-baseline gap-2 overflow-hidden font-mono text-[12px] whitespace-nowrap"
                style={{ left: b.x + 18, top: b.y + 6, maxWidth: b.w - 36 }}
              >
                <span className="text-foreground/80 shrink-0 tracking-[0.12em] uppercase">{regionLabel(b.region)}</span>
                {lens === 'traffic' && t && t.rate === null ? <span className="text-muted-foreground">no traffic data yet</span> : null}
                {b.region ? null : <span className="text-muted-foreground normal-case">set a region on the server</span>}
                <Depth at="controls">
                  <span className="text-muted-foreground truncate">{b.region ? `swarmy.region=${b.region}` : 'no swarmy.region label'}</span>
                </Depth>
              </div>
            );
          })}
          {[...cards.values()].map((c) => {
            const s = byId.get(c.id);
            return s ? <ServerCard key={c.id} s={s} lens={lens} className="absolute" style={{ left: c.x, top: c.y, width: c.w, height: c.h }} /> : null;
          })}
          <span className="sr-only">
            {flows.map((f) => `${regionArea(f.region) ?? 'Unlabelled'} visitors: ${Math.round(f.rate)} a minute.`).join(' ')}
          </span>
        </>
      ) : null}
    </div>
  );
}
