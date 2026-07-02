import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ReactFlowProvider } from '@xyflow/react';
import { ServiceCanvas } from '@/components/canvas/service-canvas';

/** Overview tab: the live service canvas, scoped to this stack. */
export const Route = createFileRoute('/_authed/stacks/$name/')({
  component: StackOverviewTab,
});

function StackOverviewTab(): React.JSX.Element {
  const { name } = Route.useParams();
  const navigate = useNavigate();
  return (
    <div className="h-[calc(100dvh-10rem)] min-h-[420px] w-full lg:h-[calc(100vh-16.5rem)]">
      <ReactFlowProvider key={name}>
        <ServiceCanvas stackFilter={name} onBack={() => navigate({ to: '/' })} />
      </ReactFlowProvider>
    </div>
  );
}
