import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowLeftRightIcon, HouseIcon, ServerIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import { useSize } from '@/components/estate-map/use-media';
import { layoutMeshGraph, type GraphNode, type LinkKind, type MeshPeerLike } from './mesh-graph-model';

const STROKE: Record<LinkKind, { stroke: string; width: number; dash?: string; opacity: number }> = {
  direct: { stroke: 'var(--color-tone-mesh)', width: 1.8, opacity: 0.75 },
  unknown: { stroke: 'var(--color-tone-idle)', width: 1.2, opacity: 0.5 },
  relayed: { stroke: 'var(--color-tone-warn)', width: 1.5, dash: '5 5', opacity: 0.8 },
  joining: { stroke: 'var(--color-primary)', width: 1.6, dash: '3 6', opacity: 0.9 },
};

/** What a server's line under its name says, in Summary words. */
const SAY: Record<GraphNode['state'], string> = {
  direct: 'direct',
  relayed: 'through a relay',
  unknown: 'connected',
  joining: 'joining…',
  trouble: "can't connect",
};

/**
 * Board 14's map: every server on the private network with its address, the
 * NAT'd ones in their zone behind the router, solid direct links, dashed
 * links through the relay, and a joining server reaching in. Each server
 * opens its page.
 */
export function MeshGraph({ peers, names, nat }: { peers: MeshPeerLike[]; names: Map<string, string>; nat: Set<string> }): React.JSX.Element {
  const [ref, size] = useSize<HTMLDivElement>();
  const g = React.useMemo(() => layoutMeshGraph({ peers, names, nat, width: size.w }), [peers, names, nat, size.w]);
  return (
    <figure
      ref={ref}
      aria-label="Map of the private network"
      className="relative m-0 w-full overflow-hidden rounded-xl"
      style={{
        height: size.w ? g.height : 280,
        backgroundImage: 'radial-gradient(color-mix(in oklab, var(--foreground) 7%, transparent) 1px, transparent 1px)',
        backgroundSize: '22px 22px',
      }}
    >
      {size.w > 0 ? (
        <>
          {g.zone ? (
            <>
              <span className="text-tone-warn absolute font-mono text-[10.5px] tracking-[0.08em] uppercase" style={{ left: g.zone.x + 18, top: g.zone.y - 22 }}>
                Your router · no ports open
              </span>
              <div
                aria-hidden
                className="border-tone-mesh/40 bg-tone-mesh/5 absolute rounded-3xl border-[1.5px] border-dashed"
                style={{ left: g.zone.x, top: g.zone.y, width: g.zone.w, height: g.zone.h }}
              />
              <div
                aria-hidden
                className="absolute h-2 rounded"
                style={{
                  left: g.zone.x + 18,
                  top: g.zone.y - 4,
                  width: g.zone.w - 36,
                  background: 'repeating-linear-gradient(90deg, color-mix(in oklab, var(--color-tone-warn) 70%, transparent) 0 10px, transparent 10px 16px)',
                }}
              />
              <span className="calm-eyebrow text-tone-mesh absolute" style={{ left: g.zone.x + 18, top: g.zone.y + 16 }}>
                Your house · behind NAT
              </span>
            </>
          ) : null}
          <svg aria-hidden className="absolute inset-0" width={g.width} height={g.height}>
            {g.links.map((l) => {
              const s = STROKE[l.kind];
              return <path key={l.id} d={l.d} fill="none" stroke={s.stroke} strokeWidth={s.width} strokeDasharray={s.dash} strokeOpacity={s.opacity} />;
            })}
          </svg>
          {g.relay ? (
            <div className="absolute flex w-36 flex-col items-center gap-1 text-center" style={{ left: g.relay.x - 72, top: g.relay.y - 20 }}>
              <span className="border-tone-warn bg-card flex size-10 items-center justify-center rounded-full border-[1.5px]">
                <ArrowLeftRightIcon aria-hidden className="text-tone-warn size-4" />
              </span>
              <b className="bg-card/85 rounded px-1 text-[13px] font-semibold">relay</b>
              <span className="text-muted-foreground bg-card/85 rounded px-1 font-mono text-[10.5px]">used when direct fails</span>
            </div>
          ) : null}
          {g.nodes.map((n) => (
            <Orb key={n.id} n={n} />
          ))}
        </>
      ) : null}
      <figcaption className="sr-only">
        {g.nodes.map((n) => `${n.name} ${SAY[n.state]}${n.nat ? ', behind NAT' : ''}`).join('; ')}
      </figcaption>
    </figure>
  );
}

function Orb({ n }: { n: GraphNode }): React.JSX.Element {
  const Icon = n.nat ? HouseIcon : ServerIcon;
  const joining = n.state === 'joining';
  const trouble = n.state === 'trouble';
  return (
    <Link
      to="/nodes/$nodeId"
      params={{ nodeId: n.id }}
      aria-label={`${n.name}, ${SAY[n.state]}`}
      className="focus-visible:ring-ring/50 absolute flex w-36 flex-col items-center gap-1 rounded-xl text-center outline-none focus-visible:ring-2"
      style={{ left: n.x - 72, top: n.y - 26 }}
    >
      <span
        className={cn(
          'bg-card flex size-[52px] items-center justify-center rounded-full border-[1.5px]',
          joining ? 'border-primary border-dashed' : trouble ? 'border-tone-bad' : 'border-tone-mesh/60',
        )}
      >
        <Icon aria-hidden className={cn('size-5', joining ? 'text-primary' : n.nat ? 'text-tone-mesh' : 'text-foreground')} />
      </span>
      <b className="bg-card/85 max-w-full truncate rounded px-1 text-[13px] font-semibold">{n.name}</b>
      <span className={cn('bg-card/85 rounded px-1 font-mono text-[10.5px]', joining ? 'text-primary' : trouble ? 'text-tone-bad' : 'text-tone-mesh')}>
        {joining || trouble || !n.ip ? SAY[n.state] : n.ip}
      </span>
    </Link>
  );
}
