import * as React from 'react';
import type { NodeProps } from '@xyflow/react';
import { cn } from '@swarmy/ui';
import type { ProjectFlowNode } from './build-graph';

/**
 * A project (Docker stack) as a bounding frame for its services. The label is a
 * bold navy chip with an aggregate status dot + service count; "(ungrouped)"
 * services get a subtler dashed frame labelled "Ungrouped". Non-interactive — it
 * only frames the services that drag within it.
 */
export function ProjectGroupNode({ data }: NodeProps<ProjectFlowNode>): React.JSX.Element {
  const { label, ungrouped, count, tone, regionBadges } = data;

  return (
    <div
      className={cn(
        'h-full w-full rounded-3xl border',
        ungrouped ? 'border-border/70 bg-muted/20 border-dashed' : 'border-border bg-card/40',
      )}
    >
      <div className="absolute top-3 left-4 flex items-center gap-2">
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1',
            ungrouped ? 'bg-muted/70' : 'bg-ink text-ink-foreground',
          )}
        >
          <span
            className={cn('size-2 rounded-full', tone === 'progress' && 'animate-pulse')}
            style={{ background: `var(--status-${tone})` }}
          />
          <span
            className={cn(
              'font-display text-[13px] font-bold tracking-tight',
              ungrouped && 'text-muted-foreground',
            )}
          >
            {label}
          </span>
        </span>
        <span className="mono-data text-muted-foreground text-[10px]">
          {count} {count === 1 ? 'service' : 'services'}
        </span>
      </div>
      {regionBadges && regionBadges.length > 0 && (
        <div className="absolute top-3 right-4 flex max-w-[60%] flex-wrap items-center justify-end gap-1">
          {regionBadges.map((b) => (
            <span
              key={b.region}
              title={`${b.region} · ${b.replicas} ${b.replicas === 1 ? 'replica' : 'replicas'}`}
              className="mono-data bg-muted/70 text-muted-foreground rounded-full px-2 py-0.5 text-[10px]"
            >
              {b.region}×{b.replicas}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
