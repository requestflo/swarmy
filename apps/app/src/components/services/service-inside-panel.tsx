import * as React from 'react';
import type { InvContainer } from '@swarmy/core';
import { ServiceContainersList } from './service-containers-list';
import { ServiceLogsPanel } from './service-logs-panel';
import type { ServiceTab } from './service-section-strip';

interface ServiceInsidePanelProps {
  serviceId: string;
  containers: InvContainer[] | undefined;
  onJump: (tab: ServiceTab) => void;
}

/**
 * "Inside" — the landing section after you tap a container on the canvas: the
 * live containers behind the service and the log stream, side by side on lg.
 */
export function ServiceInsidePanel({ serviceId, containers, onJump }: ServiceInsidePanelProps): React.JSX.Element {
  return (
    <div className="mt-6 grid items-start gap-4 lg:grid-cols-2">
      <ServiceContainersList containers={containers} onScaleUp={() => onJump('scale')} />
      <ServiceLogsPanel serviceId={serviceId} />
    </div>
  );
}
