import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { PlanActionView } from './gitops-types';
import { diffCounts, planGraph, shortName, type Diff, type PlanNode } from './plan-graph-model';

const BOX: Record<Diff, string> = {
  add: 'border-[1.5px] border-dashed border-status-online/80 bg-status-online/10',
  change: 'border-[1.5px] border-solid border-status-warning/75 bg-status-warning/10',
  remove: 'border-[1.5px] border-dashed border-status-offline/70 bg-status-offline/8 opacity-80',
  same: 'border border-border bg-card opacity-50',
};

const TAG: Record<Exclude<Diff, 'same'>, { text: string; tone: string }> = {
  add: { text: '+ add', tone: 'text-tone-ok' },
  change: { text: '~ change', tone: 'text-tone-warn' },
  remove: { text: '− remove', tone: 'text-tone-bad' },
};

function Box({ n }: { n: PlanNode }): React.JSX.Element {
  const tag = n.diff === 'same' ? null : TAG[n.diff];
  return (
    <li className={cn('relative min-w-0 rounded-lg px-2.5 py-1.5', BOX[n.diff])}>
      {tag ? (
        <span className={cn('bg-card absolute -top-2 right-2 rounded px-1 font-mono text-[9.5px] font-semibold whitespace-nowrap', tag.tone)}>
          {tag.text}
          {n.gate ? ` · ${n.gate}` : ''}
        </span>
      ) : null}
      <span className={cn('block truncate text-[12.5px] font-semibold', n.diff === 'remove' && 'line-through')} title={n.label}>
        {n.label}
      </span>
      {n.meta ? <span className="text-muted-foreground block truncate font-mono text-[10.5px]">{n.meta}</span> : null}
    </li>
  );
}

function Column({ title, nodes }: { title: string; nodes: PlanNode[] }): React.JSX.Element | null {
  if (!nodes.length) return null;
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <span className="mono-label text-muted-foreground">{title}</span>
      <ul className="flex flex-col gap-3" aria-label={title}>
        {nodes.map((n) => (
          <Box key={n.key} n={n} />
        ))}
      </ul>
    </div>
  );
}

/**
 * The plan as a ghosted diff of the app: dashed green boxes are added, solid
 * amber ones change, struck-through red ones go; the app's other live
 * services stay as faint ghosts. Same actions as the list, drawn in place.
 */
export function PlanGraph({ stack, actions }: { stack: string; actions: PlanActionView[] }): React.JSX.Element {
  const trpc = useTRPC();
  const live = useQuery({ ...trpc.services.list.queryOptions({ stackId: stack }), staleTime: 30_000 });
  const g = React.useMemo(
    () => planGraph(actions, (live.data ?? []).map((s) => shortName(stack, s.name))),
    [actions, live.data, stack],
  );
  const counts = diffCounts(g);
  return (
    <figure className="flex flex-col gap-2" aria-label={`Plan graph: ${counts || 'no changes'}`}>
      <div className="flex flex-col gap-4 rounded-xl border bg-[radial-gradient(var(--border)_1px,transparent_1px)] [background-size:16px_16px] p-4 sm:flex-row">
        <Column title="Front door" nodes={g.front} />
        <Column title="Services" nodes={g.services} />
        <Column title="Data" nodes={g.data} />
      </div>
      <figcaption className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10.5px]">
        <span className="text-tone-ok">╌ add</span>
        <span className="text-tone-warn">━ change</span>
        <span className="text-tone-bad">╌ remove</span>
        <span>{live.data ? 'faint = running, untouched' : 'everything else untouched'}</span>
        {counts ? <span className="ml-auto">{counts}</span> : null}
      </figcaption>
    </figure>
  );
}
