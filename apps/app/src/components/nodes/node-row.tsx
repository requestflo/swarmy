import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { CpuIcon, MemoryStickIcon, RouteIcon, ShieldIcon } from 'lucide-react';
import { Badge, StatusBadge } from '@swarmy/ui';
import { NODE_STATUS_TONE, type NodeSummary } from '@swarmy/core';
import { pct } from '@/lib/format';

interface NodeRowProps {
  node: NodeSummary;
  monthlyUsd: number | null;
  containerCount: number | null;
}

/**
 * One flat row in the Nodes list: name + status, role chips, region, cost/mo
 * (mono), live CPU/mem, containers count. Click anywhere on the row to open
 * the node page — this is the ONLY way in besides the row itself, no per-row
 * action menu duplicating the node page's consolidated controls.
 */
export function NodeRow({ node, monthlyUsd, containerCount }: NodeRowProps): React.JSX.Element {
  const navigate = useNavigate();
  const tone = NODE_STATUS_TONE[node.status] ?? 'neutral';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => void navigate({ to: '/nodes/$nodeId', params: { nodeId: node.id } })}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void navigate({ to: '/nodes/$nodeId', params: { nodeId: node.id } });
      }}
      className="hover:bg-accent/60 -mx-2 grid cursor-pointer grid-cols-2 items-center gap-3 rounded-xl px-4 py-3.5 transition-colors sm:grid-cols-[1.6fr_1fr_0.8fr_0.7fr_0.9fr_0.6fr]"
    >
      <div className="flex min-w-0 items-center gap-3">
        <StatusBadge tone={tone} label="" />
        <div className="min-w-0">
          <p className="truncate font-semibold">{node.name}</p>
          <p className="text-muted-foreground truncate text-xs">{node.hostname}</p>
        </div>
      </div>

      <div className="hidden flex-wrap items-center gap-1.5 sm:flex">
        <Badge variant={node.role === 'manager' ? 'info' : 'muted'}>{node.role}</Badge>
        {node.ingress ? (
          <Badge variant="muted" className="gap-1">
            <RouteIcon className="size-3" /> ingress
          </Badge>
        ) : null}
        {node.outlet ? (
          <Badge variant="muted" className="gap-1">
            <ShieldIcon className="size-3" /> outlet
          </Badge>
        ) : null}
      </div>

      <div className="hidden text-sm sm:block">{node.region ?? '—'}</div>

      <div className="mono-data hidden text-sm sm:block">
        {monthlyUsd != null ? `$${monthlyUsd.toFixed(0)}/mo` : '—'}
      </div>

      <div className="mono-data hidden items-center gap-3 text-xs sm:flex">
        <span className="flex items-center gap-1">
          <CpuIcon className="size-3.5" /> {pct(node.live?.cpuPercent)}
        </span>
        <span className="flex items-center gap-1">
          <MemoryStickIcon className="size-3.5" /> {pct(node.live?.memPercent)}
        </span>
      </div>

      <div className="mono-data text-muted-foreground text-right text-sm">
        {containerCount ?? '—'}
      </div>
    </div>
  );
}
