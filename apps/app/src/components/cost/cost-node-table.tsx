import * as React from 'react';
import { Link } from '@tanstack/react-router';
import type { CostNodeView } from '@swarmy/core';
import { StatusBadge, cn } from '@swarmy/ui';
import { cores, pct } from '@/lib/format';
import { NodeCostEditor } from './node-cost-editor';

/**
 * Per-node cost table — flat rows in one card: name, capacity, cpu/mem
 * utilization bars, and the inline-editable monthly cost.
 */

function UtilBar({ label, value }: { label: string; value: number | null }): React.JSX.Element {
  const v = value != null ? Math.min(100, Math.max(0, value)) : null;
  const toneClass =
    v == null
      ? 'bg-status-idle'
      : v >= 85
        ? 'bg-status-offline'
        : v >= 60
          ? 'bg-status-warning'
          : 'bg-status-online';
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="mono-label !mb-0 text-[10px]">{label}</span>
        <span className="mono-data text-xs">{pct(v)}</span>
      </div>
      <div className="bg-secondary h-1.5 w-full overflow-hidden rounded-full">
        <div
          className={cn('h-full rounded-full transition-all', toneClass)}
          style={{ width: `${v ?? 0}%` }}
        />
      </div>
    </div>
  );
}

export function CostNodeTable({ nodes }: { nodes: CostNodeView[] }): React.JSX.Element {
  return (
    <section className="card-pop overflow-hidden">
      <header className="border-border flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-5 py-3">
        <span className="mono-label !mb-0">Nodes · {nodes.length}</span>
        <span className="text-muted-foreground text-xs">
          Click a price to edit — swarmy stores it on the node itself.
        </span>
      </header>
      <div className="divide-border divide-y">
        {nodes.map((n) => (
          <div
            key={n.nodeId}
            className="hover:bg-accent/50 grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-3 px-5 py-3.5 transition-colors sm:grid-cols-[180px_1fr_1fr_auto]"
          >
            <span className="min-w-0">
              <Link
                to="/nodes/$nodeId"
                params={{ nodeId: n.nodeId }}
                className="mono-data hover:text-primary block truncate text-sm font-semibold transition-colors"
              >
                {n.name}
              </Link>
              <span className="text-muted-foreground flex items-center gap-2 text-xs">
                <StatusBadge tone={n.online ? 'online' : 'offline'} label={n.online ? 'online' : 'offline'} />
                <span className="hidden sm:inline">
                  {cores(n.cpuCores)} · {n.memGb != null ? `${n.memGb} GB` : '—'}
                </span>
              </span>
            </span>
            <div className="col-span-2 grid grid-cols-2 gap-4 sm:col-span-1 sm:contents">
              <UtilBar label={n.utilSource === 'history' ? 'CPU (recent avg)' : 'CPU'} value={n.cpuUtilPct} />
              <UtilBar label={n.utilSource === 'history' ? 'MEM (recent avg)' : 'MEM'} value={n.memUtilPct} />
            </div>
            <span className="col-start-2 row-start-1 justify-self-end sm:col-start-auto sm:row-start-auto">
              <NodeCostEditor nodeId={n.nodeId} monthlyUsd={n.monthlyUsd} />
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
