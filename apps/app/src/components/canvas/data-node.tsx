import * as React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { BoxIcon, DatabaseIcon, SearchIcon, SparklesIcon, ZapIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import { Depth, TONE_DOT } from '@/components/calm';
import { KIND_WORD } from '@/components/connections/connections-model';
import type { DataFlowNode } from './canvas-extras';
import { DROP_TARGET, useConnectMode } from './connect/connect-context';

const ICON = { postgres: DatabaseIcon, cache: ZapIcon, search: SearchIcon, vector: SparklesIcon, 'object-storage': BoxIcon } as const;

const PIN: React.CSSProperties = { opacity: 0, width: 6, height: 6, minWidth: 0, minHeight: 0, border: 'none', background: 'transparent' };

/**
 * A managed store on the app canvas (board AppCanvas): what it is, how big,
 * one live number, and how many parts use it. While connecting, the whole
 * card is a drop target. Tapping it opens the store's own page.
 */
export function DataNode({ data, selected }: NodeProps<DataFlowNode>): React.JSX.Element {
  const { spec } = data;
  const connect = useConnectMode();
  const Icon = ICON[spec.kind];
  const target = connect.on && !!connect.from;
  return (
    <div
      className={cn(
        'bg-card border-border relative w-[208px] cursor-pointer rounded-xl border border-dashed px-3.5 py-3 transition-shadow',
        'hover:border-foreground/25',
        selected && 'ring-primary/70 border-primary/60 ring-2',
        target && 'border-primary/60 bg-primary/[0.04]',
      )}
    >
      <Handle id="in" type="target" position={Position.Left} isConnectable={target} style={target ? DROP_TARGET : PIN} />
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-muted-foreground bg-muted flex size-6 shrink-0 items-center justify-center rounded-md">
          <Icon className="size-3.5" />
        </span>
        <span className="truncate text-[14px] font-semibold">{spec.name}</span>
        {spec.tone ? <span aria-hidden className={cn('ml-auto size-2 shrink-0 rounded-full', TONE_DOT[spec.tone])} /> : null}
      </div>
      <p className="text-muted-foreground mt-1 truncate text-[12px]">
        {spec.sub}
        <Depth at="controls">
          <span className="font-mono text-[11px]"> · {spec.tech}</span>
        </Depth>
      </p>
      <p className="mt-1.5 flex items-center justify-between gap-2 text-[11.5px]">
        <span className="text-muted-foreground">
          {spec.attached.length ? `${spec.attached.length} ${spec.attached.length === 1 ? 'part uses' : 'parts use'} it` : `no part uses this ${KIND_WORD[spec.kind]}`}
        </span>
        {spec.metric ? <span className="font-mono text-[11px]">{spec.metric}</span> : null}
      </p>
    </div>
  );
}
