import * as React from 'react';
import type { ServiceDetail } from '@swarmy/core';
import { Card, CardContent, CardHeader, CardTitle } from '@swarmy/ui';
import { ServiceDefinitionSection } from './service-definition-section';

interface ServiceConfigPanelProps {
  service: ServiceDetail;
}

/** "Config" — the running spec's environment plus the raw definition underneath. */
export function ServiceConfigPanel({ service }: ServiceConfigPanelProps): React.JSX.Element {
  const env = Object.entries(service.env ?? {});

  return (
    <div className="mt-6 grid gap-4">
      <Card className="card-pop border-0">
        <CardHeader>
          <CardTitle className="text-base">Environment</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {env.length ? (
            <pre className="bg-muted overflow-x-auto rounded-xl p-3 font-mono text-xs">
              {env.map(([k, v]) => `${k}=${v}`).join('\n')}
            </pre>
          ) : (
            <p className="text-muted-foreground">Nothing set. This service runs clean.</p>
          )}
        </CardContent>
      </Card>

      <ServiceDefinitionSection serviceId={service.id} />
    </div>
  );
}
