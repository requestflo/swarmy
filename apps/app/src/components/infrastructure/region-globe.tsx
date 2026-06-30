import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { geoEquirectangular, geoGraticule10, geoPath, type GeoSphere } from 'd3-geo';
import { feature } from 'topojson-client';
import { GlobeIcon } from 'lucide-react';
import { Skeleton, cn, toast } from '@swarmy/ui';
import type { NodeSummary } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
// Vite gives us the bundled asset URL (avoids inlining a ~100 KB JSON literal type
// into the typecheck); we fetch + parse it once at runtime.
import worldUrl from 'world-atlas/countries-110m.json?url';

/**
 * RegionGlobe — a 2-D world map for assigning nodes to regions.
 *
 * Self-fetches everything it needs (no props): `geodns.listRegions` for the
 * region markers (coords + live node membership / health / outlets) and
 * `nodes.list` for the draggable node markers. Drag a node onto a region marker
 * to stamp its `swarmy.region` label via `nodes.setRegion` — Docker stays the
 * source of truth; this is just a spatial editor over those labels.
 *
 * The map is rendered with d3-geo (equirectangular projection) over Natural-Earth
 * country polygons from `world-atlas`. Drag math lives in SVG user space, so the
 * single fixed viewBox keeps pointer hit-testing exact at any rendered size.
 */

const W = 960;
const MAP_H = 460;
const TRAY_H = 72;
const H = MAP_H + TRAY_H;
/** Pixel (user-space) radius within which a dropped node snaps onto a region. */
const DROP_RADIUS = 32;

const SPHERE: GeoSphere = { type: 'Sphere' };

/** Region marker view, mirrored from `geodns.listRegions` (geodns.service.ts). */
interface RegionView {
  region: string;
  lat: number;
  lng: number;
  nodeIds: string[];
  healthy: boolean;
  outlets: number;
}

interface RegionPt extends RegionView {
  x: number;
  y: number;
}

interface NodePt {
  node: NodeSummary;
  x: number;
  y: number;
  /** Whether the node is clustered around a placed region (vs. the dock). */
  assigned: boolean;
}

interface DragState {
  id: string;
  /** Region the node started in (null when unassigned) — skip no-op re-assigns. */
  fromRegion: string | null;
  x: number;
  y: number;
  /** Grab offset so the marker tracks the cursor from where it was picked up. */
  ox: number;
  oy: number;
  /** Where the drag started — used to ignore plain clicks (no real movement). */
  sx: number;
  sy: number;
}

/** Marker radius scales with how many nodes call the region home. */
function regionRadius(count: number): number {
  if (count === 0) return 4;
  return 6 + Math.min(count, 8);
}

/** Node dot colour by live status (matches the Hot Signal status vocabulary). */
function nodeFill(status: NodeSummary['status']): string {
  switch (status) {
    case 'online':
      return 'var(--color-status-online)';
    case 'draining':
      return 'var(--color-status-warning)';
    case 'offline':
      return 'var(--color-status-offline)';
    default:
      return 'var(--color-status-idle)';
  }
}

/** Region dot colour: idle when empty, else healthy/unhealthy. */
function regionFill(r: RegionView): string {
  if (r.nodeIds.length === 0) return 'var(--color-status-idle)';
  return r.healthy ? 'var(--color-status-online)' : 'var(--color-status-offline)';
}

/**
 * The static map layer (ocean + graticule + ~177 country polygons). Memoised so a
 * drag (which re-renders the markers every pointermove) never re-renders these.
 */
const WorldLayer = React.memo(function WorldLayer({
  countries,
  graticule,
}: {
  countries: string[];
  graticule: string;
}): React.JSX.Element {
  return (
    <g>
      <rect x={0} y={0} width={W} height={MAP_H} fill="var(--color-accent)" opacity={0.5} />
      {graticule ? (
        <path d={graticule} fill="none" stroke="var(--color-border)" strokeWidth={0.5} opacity={0.7} />
      ) : null}
      {countries.map((d, i) => (
        <path
          key={i}
          d={d}
          fill="var(--color-card)"
          stroke="var(--color-border)"
          strokeWidth={0.5}
        />
      ))}
    </g>
  );
});

export default function RegionGlobe(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const regionsQ = useQuery({ ...trpc.geodns.listRegions.queryOptions(), refetchInterval: 10_000 });
  const nodesQ = useQuery({ ...trpc.nodes.list.queryOptions(), refetchInterval: 10_000 });

  const setRegion = useMutation(
    trpc.nodes.setRegion.mutationOptions({
      onSuccess: (_d, vars) => {
        toast.success(`Assigned to ${vars.region}`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  // Projection + path generator are fixed (constant viewBox) — build them once.
  const projection = React.useMemo(() => geoEquirectangular().fitSize([W, MAP_H], SPHERE), []);
  const graticule = React.useMemo(() => geoPath(projection)(geoGraticule10()) ?? '', [projection]);

  // Country polygons: fetch the TopoJSON once, project each feature to an SVG path.
  const [countries, setCountries] = React.useState<string[] | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    const path = geoPath(projection);
    (async () => {
      try {
        const res = await fetch(worldUrl);
        const topo = (await res.json()) as Parameters<typeof feature>[0];
        const obj = topo.objects.countries;
        if (!obj) {
          if (!cancelled) setCountries([]);
          return;
        }
        const fc = feature(topo, obj);
        const feats = 'features' in fc ? fc.features : [fc];
        const ds = feats.map((f) => path(f) ?? '').filter(Boolean);
        if (!cancelled) setCountries(ds);
      } catch {
        // Degrade gracefully: markers still render over the graticule.
        if (!cancelled) setCountries([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projection]);

  // ── layout: project regions, cluster nodes around them, dock the rest ──
  const layout = React.useMemo(() => {
    const regionsData = (regionsQ.data ?? []) as RegionView[];
    const nodesData = nodesQ.data ?? [];

    // Project region markers, then nudge apart any that land on the same pixel
    // (e.g. us-east / us-east-1 share coordinates) so each stays a drop target.
    const projected: { r: RegionView; x: number; y: number }[] = [];
    for (const r of regionsData) {
      const p = projection([r.lng, r.lat]);
      if (!p) continue;
      projected.push({ r, x: p[0], y: p[1] });
    }
    const collisions = new Map<string, { r: RegionView; x: number; y: number }[]>();
    for (const it of projected) {
      const key = `${Math.round(it.x)}:${Math.round(it.y)}`;
      const g = collisions.get(key) ?? [];
      g.push(it);
      collisions.set(key, g);
    }
    const regionPts: RegionPt[] = [];
    for (const g of collisions.values()) {
      g.forEach((it, i) => {
        const dx = g.length > 1 ? (i - (g.length - 1) / 2) * 16 : 0;
        regionPts.push({ ...it.r, x: it.x + dx, y: it.y });
      });
    }
    const placed = new Map<string, RegionPt>();
    for (const rp of regionPts) placed.set(rp.region, rp);

    // Bucket nodes into their (placed) region vs. the unassigned dock.
    const byRegion = new Map<string, NodeSummary[]>();
    const unassigned: NodeSummary[] = [];
    for (const n of nodesData) {
      const home = n.region && placed.has(n.region) ? n.region : null;
      if (home) {
        const l = byRegion.get(home) ?? [];
        l.push(n);
        byRegion.set(home, l);
      } else {
        unassigned.push(n);
      }
    }

    const nodePts: NodePt[] = [];
    for (const [region, list] of byRegion) {
      const c = placed.get(region);
      if (!c) continue;
      const markerR = regionRadius(c.nodeIds.length);
      list.forEach((n, i) => {
        const ring = markerR + 13 + Math.floor(i / 8) * 14;
        const angle = ((i % 8) / 8) * Math.PI * 2 - Math.PI / 2;
        nodePts.push({ node: n, x: c.x + ring * Math.cos(angle), y: c.y + ring * Math.sin(angle), assigned: true });
      });
    }

    // Dock unassigned nodes in a centred row inside the tray band.
    const count = unassigned.length;
    const spacing = Math.min(34, (W - 96) / Math.max(1, count));
    const rowW = spacing * Math.max(0, count - 1);
    const startX = W / 2 - rowW / 2;
    const dockY = MAP_H + TRAY_H / 2 + 2;
    unassigned.forEach((n, i) => {
      nodePts.push({ node: n, x: startX + i * spacing, y: dockY, assigned: false });
    });

    return { regionPts, nodePts, unassignedCount: count };
  }, [regionsQ.data, nodesQ.data, projection]);

  // ── drag ──
  const svgRef = React.useRef<SVGSVGElement>(null);
  const [drag, setDrag] = React.useState<DragState | null>(null);
  const [hover, setHover] = React.useState<string | null>(null);

  function toSvg(e: React.PointerEvent): { x: number; y: number } {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return { x: 0, y: 0 };
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return { x: pt.x, y: pt.y };
  }

  function nearestRegion(x: number, y: number): RegionPt | null {
    let best: RegionPt | null = null;
    let bestD = DROP_RADIUS;
    for (const rp of layout.regionPts) {
      const d = Math.hypot(rp.x - x, rp.y - y);
      if (d <= bestD) {
        bestD = d;
        best = rp;
      }
    }
    return best;
  }

  function onNodeDown(np: NodePt, e: React.PointerEvent): void {
    if (setRegion.isPending) return;
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const p = toSvg(e);
    setDrag({
      id: np.node.id,
      fromRegion: np.node.region ?? null,
      x: np.x,
      y: np.y,
      ox: p.x - np.x,
      oy: p.y - np.y,
      sx: np.x,
      sy: np.y,
    });
  }

  function onNodeMove(e: React.PointerEvent): void {
    if (!drag) return;
    const p = toSvg(e);
    const x = p.x - drag.ox;
    const y = p.y - drag.oy;
    setDrag({ ...drag, x, y });
    setHover(nearestRegion(x, y)?.region ?? null);
  }

  function onNodeUp(e: React.PointerEvent): void {
    if (!drag) return;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    const moved = Math.hypot(drag.x - drag.sx, drag.y - drag.sy);
    const target = nearestRegion(drag.x, drag.y);
    if (moved > 6 && target && target.region !== drag.fromRegion) {
      setRegion.mutate({ id: drag.id, region: target.region });
    }
    setDrag(null);
    setHover(null);
  }

  const loading = regionsQ.isPending || nodesQ.isPending || countries === null;

  // Render the dragged node last so it lifts above its peers, but keep every node
  // keyed by id so React preserves the captured element across the reorder.
  const orderedNodes = drag
    ? [...layout.nodePts].sort(
        (a, b) => Number(a.node.id === drag.id) - Number(b.node.id === drag.id),
      )
    : layout.nodePts;

  function renderNode(np: NodePt): React.JSX.Element {
    const dragging = drag?.id === np.node.id;
    const x = dragging ? drag.x : np.x;
    const y = dragging ? drag.y : np.y;
    const r = dragging ? 8.5 : 6.5;
    const n = np.node;
    return (
      <g
        key={n.id}
        transform={`translate(${x} ${y})`}
        className="cursor-grab active:cursor-grabbing"
        style={{ touchAction: 'none', filter: dragging ? 'drop-shadow(0 4px 7px rgb(0 0 0 / 0.35))' : undefined }}
        onPointerDown={(e) => onNodeDown(np, e)}
        onPointerMove={onNodeMove}
        onPointerUp={onNodeUp}
      >
        <title>
          {n.name} · {n.region ?? 'unassigned'}
          {n.outlet ? ' · outlet' : ''} · {n.status}
        </title>
        {n.outlet ? (
          <circle r={r + 3} fill="none" stroke="var(--color-primary)" strokeWidth={1.5} />
        ) : null}
        <circle r={r} fill={nodeFill(n.status)} stroke="var(--color-background)" strokeWidth={1.75} />
      </g>
    );
  }

  return (
    <div className="card-pop select-none overflow-hidden rounded-2xl">
      <div className="border-border flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
        <div className="min-w-0">
          <h2 className="font-display flex items-center gap-2 text-base font-bold tracking-tight">
            <GlobeIcon className="text-primary size-4" /> Region map
          </h2>
          <p className="text-muted-foreground text-sm">
            Drag a node onto a region to set its <code className="mono-data">swarmy.region</code> label.
          </p>
        </div>
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
          <LegendDot color="var(--color-status-online)" label="Healthy" />
          <LegendDot color="var(--color-status-offline)" label="Unhealthy" />
          <LegendDot color="var(--color-status-idle)" label="Empty" />
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block size-2.5 rounded-full"
              style={{ background: 'var(--color-status-online)', boxShadow: '0 0 0 2px var(--color-primary)' }}
            />
            Outlet node
          </span>
        </div>
      </div>

      {loading ? (
        <div className="p-5">
          <Skeleton className="w-full rounded-xl" style={{ aspectRatio: `${W} / ${H}` }} />
        </div>
      ) : (
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="block w-full"
          style={{ aspectRatio: `${W} / ${H}`, touchAction: 'none' }}
          role="img"
          aria-label="World map of regions and nodes"
        >
          <WorldLayer countries={countries ?? []} graticule={graticule} />

          {/* Tray band for unassigned nodes. */}
          <line x1={0} y1={MAP_H} x2={W} y2={MAP_H} stroke="var(--color-border)" strokeWidth={1} />
          <rect x={0} y={MAP_H} width={W} height={TRAY_H} fill="var(--color-accent)" opacity={0.35} />
          <text x={16} y={MAP_H + 20} fontSize={11} className="mono-label" fill="var(--color-muted-foreground)">
            {layout.unassignedCount > 0 ? `UNASSIGNED · ${layout.unassignedCount}` : 'ALL NODES PLACED'}
          </text>

          {/* Region markers. */}
          {layout.regionPts.map((r) => {
            const isHover = hover === r.region && drag !== null;
            const radius = regionRadius(r.nodeIds.length);
            const empty = r.nodeIds.length === 0;
            return (
              <g key={r.region} transform={`translate(${r.x} ${r.y})`} style={{ pointerEvents: 'none' }}>
                {isHover ? (
                  <circle
                    r={radius + 11}
                    fill="color-mix(in oklab, var(--color-primary) 18%, transparent)"
                    stroke="var(--color-primary)"
                    strokeWidth={1.5}
                    strokeDasharray="3 3"
                  />
                ) : null}
                <circle
                  r={radius}
                  fill={regionFill(r)}
                  fillOpacity={empty ? 0.55 : 0.9}
                  stroke="var(--color-background)"
                  strokeWidth={1.5}
                />
                {r.outlets > 0 ? (
                  <circle r={radius + 3.5} fill="none" stroke="var(--color-primary)" strokeWidth={1.25} />
                ) : null}
                <text
                  y={radius + 13}
                  textAnchor="middle"
                  fontSize={11}
                  fontWeight={600}
                  fill={empty ? 'var(--color-muted-foreground)' : 'var(--color-foreground)'}
                  style={{ paintOrder: 'stroke', stroke: 'var(--color-background)', strokeWidth: 3 }}
                >
                  {r.region}
                </text>
                {!empty ? (
                  <text
                    y={radius + 25}
                    textAnchor="middle"
                    fontSize={9}
                    fill="var(--color-muted-foreground)"
                    style={{ paintOrder: 'stroke', stroke: 'var(--color-background)', strokeWidth: 3 }}
                  >
                    {r.nodeIds.length} node{r.nodeIds.length === 1 ? '' : 's'}
                    {r.outlets > 0 ? ` · ${r.outlets} outlet${r.outlets === 1 ? '' : 's'}` : ''}
                  </text>
                ) : null}
              </g>
            );
          })}

          {/* Node markers (dragged one rendered last). */}
          {orderedNodes.map((np) => renderNode(np))}
        </svg>
      )}

      <div className="border-border text-muted-foreground flex items-center justify-between gap-2 border-t px-5 py-3 text-xs">
        <span>
          {nodesQ.data?.length ?? 0} node{(nodesQ.data?.length ?? 0) === 1 ? '' : 's'} ·{' '}
          {layout.regionPts.length} regions
        </span>
        <span className={cn(setRegion.isPending && 'text-foreground')}>
          {setRegion.isPending ? 'Assigning…' : 'Region is a Docker node label — pushed to the swarm engine.'}
        </span>
      </div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-block size-2.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}
