import * as React from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { ServiceOverlay } from '@/components/services/service-overlay';
import { ServiceCanvas } from './service-canvas';

/**
 * The Apps "Map" view: every service across every app as one arrangeable
 * canvas. It is a view of the Apps list (a List | Map toggle), never a
 * destination of its own. Tapping a card opens the service overlay in place.
 */
export function ApplicationsCanvas(): React.JSX.Element {
  const [overlay, setOverlay] = React.useState<{ id: string; origin: { x: number; y: number } | null } | null>(
    null,
  );
  return (
    <div className="h-[calc(100dvh-20rem)] min-h-[440px] w-full overflow-hidden">
      <ReactFlowProvider key="__all__">
        <ServiceCanvas stackFilter={null} onOpenService={(id, origin) => setOverlay({ id, origin })} />
      </ReactFlowProvider>
      {overlay ? (
        <ServiceOverlay
          serviceId={overlay.id}
          origin={overlay.origin}
          onClose={() => setOverlay(null)}
          onSwitch={(id) => setOverlay({ id, origin: null })}
        />
      ) : null}
    </div>
  );
}
