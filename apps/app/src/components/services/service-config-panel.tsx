import * as React from 'react';
import type { ServiceDetail } from '@swarmy/core';
import { ServiceDefinitionSection } from './service-definition-section';
import { ServiceEnvCard } from './service-env-card';

interface ServiceConfigPanelProps {
  service: ServiceDetail;
}

/** "Config" — the running spec's environment plus the raw definition underneath. */
export function ServiceConfigPanel({ service }: ServiceConfigPanelProps): React.JSX.Element {
  return (
    <div className="mt-6 grid gap-4">
      <ServiceEnvCard serviceId={service.id} env={service.env ?? {}} />

      <ServiceDefinitionSection serviceId={service.id} />
    </div>
  );
}
