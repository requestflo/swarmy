import * as React from 'react';
import { useReactFlow, Panel } from '@xyflow/react';
import { MaximizeIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { Depth } from '@/components/calm';
import { AddAppDialog } from '@/components/stacks/add-app-dialog';
import { OtelStackToggle } from '@/components/stacks/otel-stack-toggle';

/**
 * Quiet canvas chrome: the part count and fit-view at every depth; inside an
 * app, the telemetry switch and "Add a part" from Controls up. No coral here:
 * the page owns its one next action.
 */
export function CanvasToolbar({
  count,
  stack,
}: {
  count: number;
  /** App the canvas is scoped to. */
  stack?: string;
}): React.JSX.Element {
  const { fitView } = useReactFlow();
  return (
    <Panel position="top-right" className="!m-3">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="bg-card border-border text-muted-foreground rounded-full border px-3 py-1.5 font-mono text-[11.5px]">
          {count} {count === 1 ? 'part' : 'parts'}
        </span>
        <Button
          variant="outline"
          size="icon"
          className="size-8 rounded-full pointer-coarse:size-11"
          onClick={() => fitView({ duration: 300 })}
          aria-label="Fit to view"
        >
          <MaximizeIcon className="size-4" />
        </Button>
        {stack ? (
          <Depth at="controls">
            <OtelStackToggle stack={stack} />
            <AddAppDialog stack={stack} label="Add a part" className="h-8 rounded-full pointer-coarse:h-11" />
          </Depth>
        ) : null}
      </div>
    </Panel>
  );
}
