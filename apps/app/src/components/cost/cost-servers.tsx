import * as React from 'react';
import type { CostNodeView } from '@swarmy/core';
import { CalmRow, Depth, RowList, Section } from '@/components/calm';
import { cores, pct } from '@/lib/format';
import { NodeCostEditor } from './node-cost-editor';

/** Each server's monthly price (edit from Controls; it's stored on the server as a label). */
export function CostServers({ nodes }: { nodes: CostNodeView[] }): React.JSX.Element {
  return (
    <Section id="servers" title="Servers" count={nodes.length} hint="the price you pay the host each month" flush>
      <RowList label="Server prices">
        {nodes.map((n) => (
          <CalmRow
            key={n.nodeId}
            tone={n.online ? 'ok' : 'bad'}
            name={n.name}
            sub={`${cores(n.cpuCores)} · ${n.memGb != null ? `${n.memGb} GB` : '—'}`}
            say={n.cpuUtilPct != null ? `${pct(n.cpuUtilPct)} busy, ${pct(n.memUtilPct)} of memory in use` : 'No usage numbers yet'}
            tech={`swarmy.node.cost=${n.monthlyUsd ?? 'unset'} · ${n.utilSource}`}
            to="/nodes/$nodeId"
            params={{ nodeId: n.nodeId }}
            trailing={
              <span className="ml-auto shrink-0 font-mono text-[13px] font-semibold sm:ml-0">
                {n.monthlyUsd != null ? `$${n.monthlyUsd}/mo` : <span className="text-tone-warn">no price</span>}
              </span>
            }
          />
        ))}
      </RowList>
      <Depth at="controls">
        <div id="server-prices" className="border-border mt-1 flex flex-col gap-1 border-t pt-3 pb-2">
          <p className="text-muted-foreground text-xs">Change a price. Empty clears it.</p>
          {nodes.map((n) => (
            <div key={n.nodeId} className="flex min-h-11 items-center justify-between gap-3">
              <span className="font-mono text-[13px]">{n.name}</span>
              <NodeCostEditor nodeId={n.nodeId} monthlyUsd={n.monthlyUsd} />
            </div>
          ))}
        </div>
      </Depth>
    </Section>
  );
}
