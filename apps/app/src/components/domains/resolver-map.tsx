import * as React from 'react';
import { geoEquirectangular, type GeoSphere } from 'd3-geo';
import { useWorldCountries } from '@/components/infrastructure/world-countries';
import type { ResolverView } from '@/components/ingress/domain-state';
import { RESOLVER_WORD } from './resolver-words';

const W = 960;
const H = 480;
/** Crop the empty poles: roughly 76°N to 63°S. */
const VIEW = { y: 36, h: 372 };
const SPHERE: GeoSphere = { type: 'Sphere' };

const DOT_FILL = {
  ok: 'var(--color-status-online)',
  warn: 'var(--color-status-warning)',
  idle: 'var(--color-status-idle)',
} as const;

export interface MapEdge {
  name: string;
  lat: number;
  lon: number;
}

interface Pt {
  x: number;
  y: number;
}

/** Spread markers that land on (almost) the same spot — SF / Mountain View / San Jose — into a small ring. */
function spread<T extends Pt>(pts: T[], min = 12, radius = 11): T[] {
  const groups: T[][] = [];
  for (const p of pts) {
    const g = groups.find((xs) => Math.hypot(xs[0]!.x - p.x, xs[0]!.y - p.y) < min);
    if (g) g.push(p);
    else groups.push([p]);
  }
  return groups.flatMap((g) =>
    g.length === 1
      ? g
      : g.map((p, i) => {
          const a = (2 * Math.PI * i) / g.length - Math.PI / 2;
          return { ...p, x: g[0]!.x + radius * Math.cos(a), y: g[0]!.y + radius * Math.sin(a) };
        }),
  );
}

/**
 * The "what the world sees" map: one dot per public resolver at its
 * operator's home city, coloured by what it answered, plus your edge servers.
 * Equirectangular over the shared Natural-Earth outlines; lazy-loaded.
 */
export default function ResolverMap({ resolvers, edges, label }: { resolvers: ResolverView[]; edges: MapEdge[]; label: string }): React.JSX.Element {
  const projection = React.useMemo(() => geoEquirectangular().fitSize([W, H], SPHERE), []);
  const countries = useWorldCountries(projection);
  const dots = React.useMemo(
    () =>
      spread(
        resolvers.flatMap((r) => {
          const p = r.lat !== null && r.lon !== null ? projection([r.lon, r.lat]) : null;
          return p ? [{ r, x: p[0], y: p[1] }] : [];
        }),
      ),
    [resolvers, projection],
  );
  const edgePts = React.useMemo(
    () =>
      edges.flatMap((e) => {
        const p = projection([e.lon, e.lat]);
        return p ? [{ e, x: p[0], y: p[1] }] : [];
      }),
    [edges, projection],
  );
  return (
    <svg viewBox={`0 ${VIEW.y} ${W} ${VIEW.h}`} role="img" aria-label={label} className="block h-auto w-full">
      {(countries ?? []).map((d, i) => (
        <path key={i} d={d} fill="var(--color-muted-foreground)" fillOpacity={0.16} stroke="var(--color-muted-foreground)" strokeOpacity={0.3} strokeWidth={0.6} />
      ))}
      {edgePts.map(({ e, x, y }) => (
        <g key={`edge-${e.name}`}>
          <title>{`${e.name} · your edge server`}</title>
          <circle cx={x} cy={y} r={16} fill="var(--color-foreground)" opacity={0.08} />
          <rect x={x - 6} y={y - 6} width={12} height={12} transform={`rotate(45 ${x} ${y})`} fill="var(--color-foreground)" stroke="var(--color-card)" strokeWidth={2} />
        </g>
      ))}
      {dots.map(({ r, x, y }) => {
        const w = RESOLVER_WORD[r.state];
        return (
          <circle key={r.id} cx={x} cy={y} r={8} fill={DOT_FILL[w.tone as keyof typeof DOT_FILL] ?? DOT_FILL.idle} stroke="var(--color-card)" strokeWidth={2.5}>
            <title>{`${r.name} · ${r.city ?? ''} · ${w.word}`}</title>
          </circle>
        );
      })}
      {/* Labels last, so a resolver dot never covers a server's name. */}
      {edgePts.map(({ e, x, y }) => (
        <text key={`label-${e.name}`} x={x + 14} y={y - 10} className="fill-foreground stroke-card font-mono font-semibold max-sm:hidden" fontSize={17} strokeWidth={5} paintOrder="stroke">
            {e.name}
          </text>
      ))}
    </svg>
  );
}
