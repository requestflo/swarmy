import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ReactFlowProvider } from '@xyflow/react';
import { ServiceCanvas } from '@/components/canvas/service-canvas';
import { ServiceOverlay } from '@/components/services/service-overlay';

interface StackOverviewSearch {
  /** Open service overlay — in the URL so it deep-links and Back closes it. */
  service?: string;
}

/** Overview tab: the live service canvas, scoped to this stack. */
export const Route = createFileRoute('/_authed/stacks/$name/')({
  validateSearch: (search: Record<string, unknown>): StackOverviewSearch =>
    typeof search.service === 'string' && search.service ? { service: search.service } : {},
  component: StackOverviewTab,
});

function StackOverviewTab(): React.JSX.Element {
  const { name } = Route.useParams();
  const { service } = Route.useSearch();
  const navigate = useNavigate();
  const routeNavigate = Route.useNavigate();
  // Tap position, kept out of the URL — a deep link just zooms from center.
  const originRef = React.useRef<{ x: number; y: number } | null>(null);

  return (
    <div className="h-full w-full">
      <ReactFlowProvider key={name}>
        <ServiceCanvas
          stackFilter={name}
          onBack={() => navigate({ to: '/' })}
          onOpenService={(id, origin) => {
            originRef.current = origin;
            void routeNavigate({ search: { service: id }, resetScroll: false });
          }}
        />
      </ReactFlowProvider>
      {service ? (
        <ServiceOverlay
          serviceId={service}
          origin={originRef.current}
          onClose={() => void routeNavigate({ search: {}, resetScroll: false })}
          onSwitch={(id) => {
            originRef.current = null;
            void routeNavigate({ search: { service: id }, replace: true, resetScroll: false });
          }}
        />
      ) : null}
    </div>
  );
}
