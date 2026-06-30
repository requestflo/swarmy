import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useReactFlow, Panel } from '@xyflow/react';
import { MaximizeIcon, RocketIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { AddAppDialog } from '@/components/stacks/add-app-dialog';
import { OtelStackToggle } from '@/components/stacks/otel-stack-toggle';

/** Floating canvas chrome: wayfinding + service count + fit-view + the one coral CTA. */
export function CanvasToolbar({
  count,
  stack,
}: {
  count: number;
  /** Stack the canvas is scoped to (drill-in), or null for the flat all-services view. */
  stack?: string | null;
}): React.JSX.Element {
  const navigate = useNavigate();
  const { fitView } = useReactFlow();

  return (
    <Panel position="top-right" className="!m-4">
      <div className="flex items-center gap-2">
        <span className="card-pop mono-data text-muted-foreground rounded-full px-3 py-2 text-xs">
          {count} {count === 1 ? 'service' : 'services'}
        </span>
        <Button
          variant="outline"
          size="icon"
          className="rounded-full"
          onClick={() => fitView({ duration: 400 })}
          aria-label="Fit to view"
        >
          <MaximizeIcon className="size-4" />
        </Button>
        {/* Drilled into a stack → per-stack telemetry opt-in (Docker-label backed). */}
        {stack ? <OtelStackToggle stack={stack} /> : null}
        {/* Drilled into a stack → contextual deploy: add a single app straight into it. */}
        {stack ? <AddAppDialog stack={stack} /> : null}
        <Button className="gap-2" onClick={() => navigate({ to: '/services/new' })}>
          <RocketIcon className="size-4" /> Deploy
        </Button>
      </div>
    </Panel>
  );
}
