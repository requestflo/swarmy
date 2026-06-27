import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { CpuIcon, MemoryStickIcon } from 'lucide-react';
import { Badge, Progress, StatusBadge, cn } from '@swarmy/ui';
import { NODE_STATUS_TONE, type NodeSummary } from '@swarmy/core';
import { bytes, cores, pct, relTime } from '@/lib/format';

/** A single node as a premium card (the Infrastructure plane is a grid of these). */
export function NodeCard({ node }: { node: NodeSummary }): React.JSX.Element {
  const tone = NODE_STATUS_TONE[node.status] ?? 'neutral';
  return (
    <Link
      to="/nodes/$nodeId"
      params={{ nodeId: node.id }}
      className="card-pop card-pop-hover block rounded-2xl p-5"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-display truncate text-lg font-bold tracking-tight">{node.name}</p>
          <p className="text-muted-foreground mono-label truncate">{node.hostname}</p>
        </div>
        <StatusBadge tone={tone} label={node.status} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Badge variant={node.role === 'manager' ? 'default' : 'secondary'}>{node.role}</Badge>
        <span className="text-muted-foreground text-xs">
          {node.os ?? 'unknown'} · {node.arch ?? '—'}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4">
        <Metric icon={<CpuIcon className="size-3.5" />} label={`CPU ${pct(node.live?.cpuPercent)}`} value={node.live?.cpuPercent ?? 0} sub={cores(node.resources.cpus)} />
        <Metric icon={<MemoryStickIcon className="size-3.5" />} label={`MEM ${pct(node.live?.memPercent)}`} value={node.live?.memPercent ?? 0} sub={bytes(node.resources.memBytes)} />
      </div>

      <p className="text-muted-foreground mt-4 text-[11px]">
        {node.status === 'online' ? 'Live now' : `Last seen ${relTime(node.lastSeenAt)}`}
        {node.agentVersion ? ` · agent ${node.agentVersion}` : ''}
      </p>
    </Link>
  );
}

function Metric({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  sub: string;
}): React.JSX.Element {
  return (
    <div>
      <div className={cn('mono-label flex items-center gap-1')}>
        {icon}
        {label}
      </div>
      <Progress value={value} className="mt-1.5" />
      <p className="text-muted-foreground mt-1 text-[11px]">{sub}</p>
    </div>
  );
}
