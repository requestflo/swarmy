import * as React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { GlobeIcon, LockIcon } from 'lucide-react';
import type { DomainFlowNode } from './canvas-extras';

const PIN: React.CSSProperties = { opacity: 0, width: 6, height: 6, minWidth: 0, minHeight: 0, border: 'none', background: 'transparent' };

/**
 * The app's front door on the canvas: its address, whether visitors get HTTPS
 * and the visits a second at the edge right now. Tapping it opens Domains.
 */
export function DomainNode({ data }: NodeProps<DomainFlowNode>): React.JSX.Element {
  const { host, more, https, rate } = data.domain;
  const facts = [https ? 'HTTPS' : 'no HTTPS yet', rate].filter(Boolean).join(' · ');
  return (
    <div className="bg-card/70 border-border flex w-[220px] cursor-pointer flex-col gap-1 rounded-xl border border-dashed px-3 py-2.5 hover:border-foreground/25">
      <Handle id="out" type="source" position={Position.Bottom} isConnectable={false} style={PIN} />
      <span className="flex min-w-0 items-center gap-2">
        <GlobeIcon aria-hidden className="text-primary size-3.5 shrink-0" />
        <span className="truncate text-[13px] font-semibold">{host}</span>
      </span>
      <span className="text-muted-foreground flex items-center gap-1.5 font-mono text-[10.5px]">
        {https ? <LockIcon aria-hidden className="text-tone-ok size-2.5" /> : null}
        {facts}
        {more > 0 ? <span className="ml-auto">+{more}</span> : null}
      </span>
    </div>
  );
}
