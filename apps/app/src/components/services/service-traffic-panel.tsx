import * as React from 'react';
import type { ServiceDetail } from '@swarmy/core';
import { Card, CardContent, CardHeader, CardTitle } from '@swarmy/ui';
import { ExposeModeControl } from '@/components/exposure/expose-mode-control';
import { ServiceIngressPanel } from './service-ingress-panel';
import { ServicePortsList } from './service-ports-list';

interface ServiceTrafficPanelProps {
  service: ServiceDetail;
}

/** "Traffic" — how the world reaches this service: routes, exposure intent, ports. */
export function ServiceTrafficPanel({ service }: ServiceTrafficPanelProps): React.JSX.Element {
  return (
    <div className="mt-6 grid items-start gap-4 lg:grid-cols-2">
      <Card className="card-pop border-0">
        <CardContent className="p-6">
          <ServiceIngressPanel serviceId={service.id} serviceName={service.name} />
        </CardContent>
      </Card>

      <Card className="card-pop border-0">
        <CardHeader>
          <CardTitle className="text-base">Exposure & ports</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-6">
          <div className="flex items-center justify-between gap-4">
            <p className="mono-label !mb-0">Exposure</p>
            <ExposeModeControl serviceId={service.id} />
          </div>
          <ServicePortsList ports={service.ports} />
        </CardContent>
      </Card>
    </div>
  );
}
