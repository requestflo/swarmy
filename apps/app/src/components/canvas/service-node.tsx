import * as React from 'react';
import type { NodeProps } from '@xyflow/react';
import { LayersIcon, ServerIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import type { ServiceFlowNode } from './build-graph';

/**
 * A service as a draggable canvas card (Hot Signal). Shows status, image tag,
 * replica health, and the placement badge that answers "where does this run".
 * Presentational — selection + click are owned by the ReactFlow orchestrator.
 */
export function ServiceNode({ data, selected }: NodeProps<ServiceFlowNode>): React.JSX.Element {
  const { service, placement, tone, stackName } = data;
  const replicasOk = service.replicas.running >= service.replicas.desired;

  return (
    <div
      className={cn(
        'card-pop w-60 cursor-pointer rounded-2xl px-4 py-3 transition-shadow',
        selected
          ? 'ring-primary shadow-[0_12px_32px_-10px_var(--primary)] ring-2'
          : 'hover:shadow-[0_14px_34px_-16px_rgba(0,0,0,0.4)]',
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn('size-2.5 shrink-0 rounded-full bg-current', tone === 'progress' && 'animate-pulse')}
          style={{ color: `var(--status-${tone})` }}
        />
        <span className="font-display truncate text-[15px] font-bold tracking-tight">{service.name}</span>
        {service.ingressEnabled && <span className="bg-primary/15 text-primary ml-auto rounded-full px-2 py-0.5 text-[10px] font-bold">public</span>}
      </div>

      <p className="mono-data text-muted-foreground mt-1.5 truncate text-xs">{service.image}</p>

      <div className="mt-3 flex items-center justify-between">
        <span className={cn('mono-data text-xs', replicasOk ? 'text-status-online' : 'text-status-warning')}>
          {service.replicas.running}/{service.replicas.desired} up
        </span>
        <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
          <ServerIcon className="size-3.5" />
          <span className="max-w-24 truncate">{placement}</span>
        </span>
      </div>

      {stackName && (
        <div className="border-border/70 mt-2.5 flex items-center gap-1 border-t pt-2">
          <LayersIcon className="text-muted-foreground size-3" />
          <span className="text-muted-foreground truncate text-[11px]">{stackName}</span>
        </div>
      )}
    </div>
  );
}
