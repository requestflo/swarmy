import * as React from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useTRPC } from '@/integrations/trpc';
import { ServiceOverlay } from '@/components/services/service-overlay';
import { StackOverview } from './stack-overview';
import { ServiceCanvas } from './service-canvas';
import { CanvasEmpty } from './canvas-empty';

type View = { mode: 'stacks' } | { mode: 'all' };

/**
 * Viewport-fit canvas frame: 100dvh minus the shell's mobile header (3.5rem) +
 * tab-bar clearance (7rem); a clean h-dvh on lg where nothing sits above
 * <main>. Doubles as the placeholder so the page doesn't jump while the first
 * poll lands.
 */
function CanvasShell({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="h-[calc(100dvh-10.5rem)] min-h-[480px] w-full overflow-hidden px-2 lg:h-dvh lg:px-4 lg:py-4">
      {children}
    </div>
  );
}

/**
 * The Stacks home. Defaults to the STACK overview — swarmy discovers and groups
 * every Docker stack into a premium card grid. Opening a stack navigates to its
 * workspace (`/stacks/$name` — a real URL with tabs for everything the app
 * owns); "All services" shows the flat cross-swarm canvas.
 */
export function ApplicationsCanvas(): React.JSX.Element {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const inventory = useQuery({ ...trpc.inventory.get.queryOptions(), refetchInterval: 4_000 });
  const [view, setView] = React.useState<View>({ mode: 'stacks' });
  const [overlay, setOverlay] = React.useState<{ id: string; origin: { x: number; y: number } | null } | null>(
    null,
  );

  // No services anywhere → sell the first deploy (not an empty grid).
  if (!inventory.isLoading && (inventory.data?.services.length ?? 0) === 0) return <CanvasEmpty />;

  if (view.mode === 'stacks') {
    if (!inventory.data) return <CanvasShell />;
    return (
      <StackOverview
        inv={inventory.data}
        onOpenStack={(stack) => navigate({ to: '/stacks/$name', params: { name: stack } })}
        onShowAll={() => setView({ mode: 'all' })}
      />
    );
  }

  // The flat cross-swarm canvas ("All services").
  return (
    <CanvasShell>
      <ReactFlowProvider key="__all__">
        <ServiceCanvas
          stackFilter={null}
          onBack={() => setView({ mode: 'stacks' })}
          onOpenService={(id, origin) => setOverlay({ id, origin })}
        />
      </ReactFlowProvider>
      {overlay ? (
        <ServiceOverlay
          serviceId={overlay.id}
          origin={overlay.origin}
          onClose={() => setOverlay(null)}
          onSwitch={(id) => setOverlay({ id, origin: null })}
        />
      ) : null}
    </CanvasShell>
  );
}
