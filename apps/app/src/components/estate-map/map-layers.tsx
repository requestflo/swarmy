import * as React from 'react';
import { blobPath } from './blob-path';
import type { Flow } from './map-flows';
import type { MapLayout, PlacedCard } from './map-layout';

/** The soft region blobs (decorative; the labels and cards carry the meaning). */
export function BlobLayer({ layout }: { layout: MapLayout }): React.JSX.Element {
  return (
    <g>
      {layout.blobs.map((b) => (
        <path
          key={b.region ?? '~none'}
          d={blobPath(b, b.region ?? 'none')}
          fill="var(--color-foreground)"
          fillOpacity={0.035}
          stroke="var(--color-foreground)"
          strokeOpacity={b.region ? 0.16 : 0.12}
          strokeDasharray={b.region ? undefined : '5 6'}
          strokeWidth={1.25}
        />
      ))}
    </g>
  );
}

/** Dotted visitor flows from the canvas edge into each region; the dots drift unless motion is reduced. */
export function FlowLayer({ flows, still }: { flows: Flow[]; still: boolean }): React.JSX.Element {
  return (
    <g>
      {flows.map((f) => (
        <g key={f.region ?? '~none'}>
          <path d={f.d} fill="none" stroke="var(--color-primary)" strokeOpacity={0.22} strokeWidth={1} />
          <path d={f.d} fill="none" stroke="var(--color-primary)" strokeWidth={3.5} strokeLinecap="round" strokeDasharray="0.1 14">
            {still ? null : <animate attributeName="stroke-dashoffset" from="28" to="0" dur="1.4s" repeatCount="indefinite" />}
          </path>
          <circle cx={endOf(f.d)[0]} cy={endOf(f.d)[1]} r={4} fill="var(--color-primary)" />
        </g>
      ))}
    </g>
  );
}

function endOf(d: string): [number, number] {
  const nums = d.match(/-?\d+(\.\d+)?/g) ?? ['0', '0'];
  return [Number(nums.at(-2)), Number(nums.at(-1))];
}

/** Faint dashed private-network links between servers (the Mesh lens). */
export function MeshLayer({ links, cards }: { links: { a: string; b: string; ok: boolean }[]; cards: Map<string, PlacedCard> }): React.JSX.Element {
  return (
    <g>
      {links.flatMap((l) => {
        const a = cards.get(l.a);
        const b = cards.get(l.b);
        if (!a || !b) return [];
        const [ax, ay, bx, by] = [a.x + a.w / 2, a.y + a.h / 2, b.x + b.w / 2, b.y + b.h / 2];
        const mx = (ax + bx) / 2;
        const my = (ay + by) / 2 - Math.min(80, Math.abs(bx - ax) / 6);
        return [
          <path
            key={`${l.a}-${l.b}`}
            d={`M${ax} ${ay} Q ${mx} ${my} ${bx} ${by}`}
            fill="none"
            stroke={l.ok ? 'var(--color-tone-mesh)' : 'var(--color-tone-idle)'}
            strokeOpacity={l.ok ? 0.7 : 0.5}
            strokeWidth={1.5}
            strokeDasharray="4 6"
          />,
        ];
      })}
    </g>
  );
}
