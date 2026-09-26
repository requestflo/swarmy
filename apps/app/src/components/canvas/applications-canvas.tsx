import * as React from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { ServiceSettingsPanel } from '@/components/service-settings/service-settings-panel';
import { ServiceCanvas } from './service-canvas';

/**
 * The Apps "Map" view: every service across every app as one arrangeable
 * canvas. It is a view of the Apps list (a List | Map toggle), never a
 * destination of its own. Tapping a card opens that part's settings panel.
 */
export function ApplicationsCanvas(): React.JSX.Element {
  const [open, setOpen] = React.useState<string | null>(null);
  return (
    <div className="h-[calc(100dvh-20rem)] min-h-[440px] w-full overflow-hidden">
      <ReactFlowProvider key="__all__">
        <ServiceCanvas stackFilter={null} selectedId={open ?? undefined} onOpenService={(id) => setOpen(id)} />
      </ReactFlowProvider>
      {open ? <ServiceSettingsPanel serviceId={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
