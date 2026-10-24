import * as React from 'react';
import { cn } from '@swarmy/ui';
import { TONE_DOT } from '@/components/calm';
import type { Graph, GraphKind, GraphNode, NodeState } from './graph-model';

const GROUPS: Array<[GraphKind, string]> = [
  ['domain', 'Addresses'],
  ['service', 'Services'],
  ['resource', 'Resources'],
  ['job', 'Jobs'],
];
const DOT: Record<NodeState, string> = { same: TONE_DOT.idle, added: TONE_DOT.ok, changed: TONE_DOT.warn, bad: TONE_DOT.bad };
const WORD: Partial<Record<NodeState, string>> = { added: 'new', changed: 'changed', bad: 'problem' };

/**
 * The graph as grouped rows on a phone, where a drawing would be too small
 * to read: what the file builds, with new, changed, problem and removed
 * marked in words beside the dot.
 */
export function GraphList({ graph, state, removed }: { graph: Graph; state: ReadonlyMap<string, NodeState>; removed: GraphNode[] }): React.JSX.Element {
  const row = (n: GraphNode, s: NodeState | 'removed'): React.JSX.Element => (
    <li key={`${s}:${n.id}`} className="border-border flex min-h-10 items-center gap-2.5 border-b last:border-b-0">
      <span aria-hidden className={cn('size-2 shrink-0 rounded-full', s === 'removed' ? TONE_DOT.bad : DOT[s])} />
      <span className={cn('min-w-0 truncate text-[13px] font-semibold', s === 'removed' && 'text-muted-foreground line-through')}>{n.name}</span>
      <span className="text-muted-foreground min-w-0 truncate font-mono text-[11px]">{n.meta}</span>
      {s === 'removed' || WORD[s] ? (
        <span className={cn('ml-auto shrink-0 text-xs font-semibold', s === 'added' ? 'text-tone-ok' : s === 'changed' ? 'text-tone-warn' : 'text-tone-bad')}>
          {s === 'removed' ? 'removed' : WORD[s]}
        </span>
      ) : null}
    </li>
  );
  return (
    <div className="flex flex-col gap-3">
      {GROUPS.map(([kind, title]) => {
        const nodes = graph.nodes.filter((n) => n.kind === kind);
        const gone = removed.filter((n) => n.kind === kind);
        if (!nodes.length && !gone.length) return null;
        return (
          <div key={kind}>
            <h3 className="calm-eyebrow mb-1">{title}</h3>
            <ul className="flex flex-col">
              {nodes.map((n) => row(n, state.get(n.id) ?? 'same'))}
              {gone.map((n) => row(n, 'removed'))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
