import * as React from 'react';
import { useReactFlow, Panel } from '@xyflow/react';
import { CodeIcon, MaximizeIcon, SplineIcon } from 'lucide-react';
import { Button, cn } from '@swarmy/ui';
import { Depth } from '@/components/calm';
import { AddAppDialog } from '@/components/stacks/add-app-dialog';
import { OtelStackToggle } from '@/components/stacks/otel-stack-toggle';

/** Top right: the part count at every depth; the telemetry switch from Controls up. */
export function CanvasToolbar({ count, stack }: { count: number; stack?: string }): React.JSX.Element {
  return (
    <Panel position="top-right" className="!m-3">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="bg-card border-border text-muted-foreground rounded-full border px-3 py-1.5 font-mono text-[11.5px]">
          {count} {count === 1 ? 'part' : 'parts'}
        </span>
        {stack ? (
          <Depth at="controls">
            <OtelStackToggle stack={stack} />
          </Depth>
        ) : null}
      </div>
    </Panel>
  );
}

const TOOL = 'h-8 gap-1.5 rounded-[10px] px-2.5 text-[12.5px] pointer-coarse:h-11';

/**
 * The canvas's tool row (board AppCanvas): Add a part · Connect · Compose ·
 * Fit. Quiet buttons only; the page owns its one coral action. Connect and
 * Compose are toggles (`aria-pressed`).
 */
export function CanvasTools({
  stack,
  connecting,
  onConnect,
  composing,
  onCompose,
}: {
  stack: string;
  connecting: boolean;
  onConnect: () => void;
  composing: boolean;
  onCompose: () => void;
}): React.JSX.Element {
  const { fitView } = useReactFlow();
  const on = 'bg-primary/10 text-primary';
  return (
    <Panel position="bottom-center" className="!mb-3">
      <div role="toolbar" aria-label="Canvas tools" className="bg-card/95 border-border flex items-center gap-0.5 rounded-[13px] border p-1 shadow-sm backdrop-blur">
        <AddAppDialog stack={stack} label="Add a part" className={cn(TOOL, 'border-0 shadow-none')} />
        <Button variant="ghost" className={cn(TOOL, connecting && on)} aria-pressed={connecting} onClick={onConnect}>
          <SplineIcon className="size-3.5" />
          Connect
        </Button>
        <Button variant="ghost" className={cn(TOOL, composing && on)} aria-pressed={composing} onClick={onCompose}>
          <CodeIcon className="size-3.5" />
          Compose
        </Button>
        <Button variant="ghost" className={TOOL} onClick={() => void fitView({ duration: 300, padding: 0.08, maxZoom: 1 })}>
          <MaximizeIcon className="size-3.5" />
          Fit
        </Button>
      </div>
    </Panel>
  );
}
