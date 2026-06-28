import * as React from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { StackOverview } from './stack-overview';
import { ServiceCanvas } from './service-canvas';
import { CanvasEmpty } from './canvas-empty';

type View = { mode: 'stacks' } | { mode: 'stack'; stack: string } | { mode: 'all' };

/** Full-height placeholder so the page doesn't jump while the first poll lands. */
function CanvasShell({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return <div className="h-[calc(100dvh-9.5rem)] w-full lg:h-[calc(100vh-6rem)]">{children}</div>;
}

/**
 * The Applications plane. Defaults to the STACK overview — swarmy discovers and
 * groups every Docker stack into a premium card grid. Clicking a stack drills
 * into the service-level canvas scoped to it; "All services" shows the flat
 * cross-swarm canvas. Drag-persist (canvas.get/save) works in either canvas view.
 */
export function ApplicationsCanvas(): React.JSX.Element {
  const trpc = useTRPC();
  const inventory = useQuery({ ...trpc.inventory.get.queryOptions(), refetchInterval: 4_000 });
  const [view, setView] = React.useState<View>({ mode: 'stacks' });

  // No services anywhere → sell the first deploy (not an empty grid).
  if (!inventory.isLoading && (inventory.data?.services.length ?? 0) === 0) return <CanvasEmpty />;

  if (view.mode === 'stacks') {
    if (!inventory.data) return <CanvasShell />;
    return (
      <StackOverview
        inv={inventory.data}
        onOpenStack={(stack) => setView({ mode: 'stack', stack })}
        onShowAll={() => setView({ mode: 'all' })}
      />
    );
  }

  const stackFilter = view.mode === 'stack' ? view.stack : null;
  // Keyed so switching scope remounts the flow and re-fits to the new subgraph.
  return (
    <ReactFlowProvider key={stackFilter ?? '__all__'}>
      <ServiceCanvas stackFilter={stackFilter} onBack={() => setView({ mode: 'stacks' })} />
    </ReactFlowProvider>
  );
}
