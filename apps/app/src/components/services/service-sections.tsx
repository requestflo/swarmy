import * as React from 'react';
import type { InvContainer, ServiceDetail } from '@swarmy/core';
import { Card, CardContent } from '@swarmy/ui';
import { ServiceCicdPanel } from './service-cicd-panel';
import { ServiceConfigPanel } from './service-config-panel';
import { ServiceDangerSection } from './service-danger-section';
import { ServiceInsidePanel } from './service-inside-panel';
import { ServiceScalePanel } from './service-scale-panel';
import type { ServiceTab } from './service-section-strip';
import { ServiceTrafficPanel } from './service-traffic-panel';

interface ServiceSectionsProps {
  tab: ServiceTab;
  service: ServiceDetail;
  containers: InvContainer[] | undefined;
  asleep: boolean;
  onJump: (tab: ServiceTab) => void;
}

/** Renders the active jobs-to-be-done section for the service page. */
export function ServiceSections({ tab, service, containers, asleep, onJump }: ServiceSectionsProps): React.JSX.Element {
  switch (tab) {
    case 'inside':
      return <ServiceInsidePanel serviceId={service.id} containers={containers} onJump={onJump} />;
    case 'traffic':
      return <ServiceTrafficPanel service={service} />;
    case 'scale':
      return <ServiceScalePanel service={service} asleep={asleep} />;
    case 'ship':
      return (
        <Card className="card-pop mt-6 border-0 lg:max-w-2xl">
          <CardContent className="p-6">
            <ServiceCicdPanel serviceId={service.id} serviceName={service.name} />
          </CardContent>
        </Card>
      );
    case 'config':
      return <ServiceConfigPanel service={service} />;
    case 'danger':
      return <ServiceDangerSection serviceId={service.id} serviceName={service.name} />;
  }
}
