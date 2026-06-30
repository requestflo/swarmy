import * as React from 'react';
import type { NodeProps } from '@xyflow/react';
import { DatabaseIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import type { DbClusterFlowNode } from './build-graph';

/** A small role pill (primary / replica) with a live-health dot. */
function RolePill({
  label,
  detail,
  tone,
}: {
  label: string;
  detail: string;
  tone: string;
}): React.JSX.Element {
  return (
    <span
      className="bg-card/80 border-border/60 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5"
      title={`${label} · ${detail}`}
    >
      <span
        className={cn('size-2 rounded-full', tone === 'progress' && 'animate-pulse')}
        style={{ background: `var(--status-${tone})` }}
      />
      <span className="mono-label !mb-0 !text-[9px]">{label}</span>
      <span className="mono-data text-muted-foreground text-[10px]">{detail}</span>
    </span>
  );
}

/**
 * A managed-DB cluster as a bounding frame for its primary + replica services
 * (epic #8). Mirrors the project-group frame, but db-branded: a DatabaseIcon
 * glyph, a primary-tinted backdrop, and per-role health pills (primary present?
 * + replica running/desired). The frame is clickable — selecting it opens the
 * cluster panel (the ReactFlow orchestrator owns the click → panel wiring).
 */
export function DbClusterNode({ data, selected }: NodeProps<DbClusterFlowNode>): React.JSX.Element {
  const { cluster, engine, count, tone, primary, replicas } = data;

  return (
    <div
      className={cn(
        'h-full w-full cursor-pointer rounded-3xl border transition-shadow',
        selected
          ? 'border-primary shadow-[0_12px_32px_-12px_var(--primary)] ring-primary/40 ring-2'
          : 'border-primary/30 bg-primary/[0.04] hover:border-primary/50',
      )}
    >
      <div className="absolute top-3 left-4 flex items-center gap-2">
        <span className="bg-primary/10 text-primary flex size-6 items-center justify-center rounded-md">
          <DatabaseIcon className="size-3.5" />
        </span>
        <span className="bg-ink text-ink-foreground inline-flex items-center gap-1.5 rounded-full px-2.5 py-1">
          <span
            className={cn('size-2 rounded-full', tone === 'progress' && 'animate-pulse')}
            style={{ background: `var(--status-${tone})` }}
          />
          <span className="font-display text-[13px] font-bold tracking-tight">{cluster}</span>
        </span>
        <span className="mono-label text-muted-foreground !mb-0 !text-[10px]">{engine}</span>
        <span className="mono-data text-muted-foreground text-[10px]">
          {count} {count === 1 ? 'service' : 'services'}
        </span>
      </div>

      <div className="absolute top-3 right-4 flex max-w-[60%] flex-wrap items-center justify-end gap-1 text-[10px]">
        <RolePill
          label="primary"
          tone={primary.present ? primary.tone : 'offline'}
          detail={primary.present ? 'up' : 'absent'}
        />
        <RolePill
          label="replica"
          tone={replicas.tone}
          detail={`${replicas.running}/${replicas.desired}`}
        />
      </div>
    </div>
  );
}
