import * as React from 'react';
import { Handle, Position, type Node as FlowNode, type NodeProps } from '@xyflow/react';
import { cn } from '@swarmy/ui';
import type { ServiceMapNodeView } from '@swarmy/core';

export interface ServiceMapNodeData extends Record<string, unknown> {
  node: ServiceMapNodeView;
}

export type ServiceMapFlowNode = FlowNode<ServiceMapNodeData, 'svcmap'>;

const HANDLE: React.CSSProperties = {
  opacity: 0,
  width: 6,
  height: 6,
  minWidth: 0,
  minHeight: 0,
  border: 'none',
  background: 'transparent',
};

/**
 * One service on the map: name, live RED numbers, and a warning tint the
 * moment its error rate or p95 breaches the target — the degraded node is the
 * thing your eye lands on.
 */
export function ServiceMapNode({ data }: NodeProps<ServiceMapFlowNode>): React.JSX.Element {
  const n = data.node;
  return (
    <div
      className={cn(
        'card-pop w-[220px] rounded-2xl px-4 py-3',
        n.degraded && 'ring-status-warning bg-status-warning/10 ring-2',
      )}
    >
      <Handle type="target" position={Position.Left} style={HANDLE} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={HANDLE} isConnectable={false} />
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'size-2 shrink-0 rounded-full',
            n.degraded ? 'bg-status-warning' : 'bg-status-online',
          )}
        />
        <p className="mono-data truncate text-sm font-semibold">{n.id}</p>
      </div>
      <div className="text-muted-foreground mt-2 flex items-center justify-between gap-2 text-[0.7rem]">
        <span className="mono-data tabular-nums">{n.callsPerMin}/min</span>
        <span className={cn('mono-data tabular-nums', n.errorRate > 0.05 && 'text-status-warning font-semibold')}>
          {(n.errorRate * 100).toFixed(1)}% err
        </span>
        <span className={cn('mono-data tabular-nums', n.p95Ms > 1500 && 'text-status-warning font-semibold')}>
          p95 {Math.round(n.p95Ms)}ms
        </span>
      </div>
    </div>
  );
}
