import * as React from 'react';
import { cn } from '@swarmy/ui';
import { layoutGraph } from './graph-layout';
import type { Graph, NodeState } from './graph-model';

const BOX: Record<NodeState, string> = {
  same: 'fill-card stroke-border',
  added: 'fill-status-online/10 stroke-status-online [stroke-dasharray:5_4]',
  changed: 'fill-card stroke-status-warning',
  bad: 'fill-status-offline/10 stroke-status-offline',
};
const DOT: Record<NodeState, string> = {
  same: 'fill-status-idle',
  added: 'fill-status-online',
  changed: 'fill-status-warning',
  bad: 'fill-status-offline',
};

/**
 * The graph drawn to scale (sm and up): addresses and schedules → services
 * → resources. A node's outline says what an edit did to it — green dashed
 * is new, amber changed, crimson has a problem; everything else stays quiet.
 */
export function GraphSvg({ graph, state, label }: { graph: Graph; state: ReadonlyMap<string, NodeState>; label: string }): React.JSX.Element {
  const l = React.useMemo(() => layoutGraph(graph), [graph]);
  const st = (id: string): NodeState => state.get(id) ?? 'same';
  return (
    <svg viewBox={`0 0 ${l.width} ${l.height}`} role="img" aria-label={label} className="block h-auto w-full">
      <title>{label}</title>
      {l.edges.map((e) => {
        const fresh = st(e.from) === 'added' || st(e.to) === 'added';
        return (
          <path
            key={`${e.from}>${e.to}`}
            d={e.d}
            fill="none"
            strokeWidth={1.5}
            className={fresh ? 'stroke-status-online [stroke-dasharray:5_5]' : 'stroke-muted-foreground/35'}
          />
        );
      })}
      {l.nodes.map((n) => {
        const s = st(n.id);
        const pill = n.kind === 'domain';
        return (
          <g key={n.id} transform={`translate(${n.x} ${n.y})`}>
            <title>{`${n.name}${n.meta ? ` — ${n.meta}` : ''}`}</title>
            <rect width={n.w} height={n.h} rx={pill ? n.h / 2 : 12} strokeWidth={1.25} className={BOX[s]} />
            <circle cx={pill ? 14 : 13} cy={pill ? n.h / 2 : 16} r={3.5} className={pill && s === 'same' ? 'fill-status-online' : DOT[s]} />
            <text x={pill ? 24 : 23} y={pill ? n.h / 2 + 4 : 20} className={cn('fill-foreground font-sans font-semibold', pill ? 'text-[11.5px]' : 'text-[12.5px]')}>
              {n.name}
            </text>
            {!pill && n.meta ? (
              <text x={11} y={36} className="fill-muted-foreground font-mono text-[10px]">
                {n.meta}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
